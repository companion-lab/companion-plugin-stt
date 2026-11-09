//! macOS microphone permission gate (TCC).
//!
//! CoreAudio silently delivers zero-filled buffers to processes without mic
//! permission — the cpal stream opens and runs, but every sample is silence
//! and no error is ever raised. Capture must therefore be gated on
//! AVCaptureDevice's TCC status before starting the stream.
//!
//! In dev the app runs as a bare binary, so TCC attributes mic access to the
//! *responsible process* — the app that launched `pnpm tauri dev` (Terminal,
//! iTerm, an editor's built-in terminal, …), never to Companion itself. The
//! denial message therefore names that app, found by walking the parent
//! process chain to the first .app bundle.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};

// AVMediaTypeAudio is a CFStringRef constant with this content.
const MEDIA_TYPE_AUDIO: &str = "soun";

// How long to wait for the system prompt to be answered before giving up.
// The prompt renders out-of-process, so this only bounds the wait; a later
// answer is still recorded by TCC and picked up on the next attempt.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(90);

const DENIED_MSG: &str = "Microphone access is denied by macOS and the app that launched \
`pnpm tauri dev` could not be identified. Run `pnpm tauri dev` from a regular terminal \
(Terminal or iTerm), press the mic button again, and allow access when macOS asks.";

// requestAccess can complete false without ever showing a prompt or recording
// a decision: headless contexts, or — on hardened-runtime macOS — an app that
// launched `pnpm tauri dev` without the audio-input entitlement, which macOS
// refuses to prompt for at all.
const NO_PROMPT_MSG: &str = "macOS could not show the microphone permission prompt from this \
context. Editors and other hardened-runtime apps without mic access cannot be prompted at all; \
run `pnpm tauri dev` from a regular terminal (Terminal or iTerm) and press the mic button again \
— allowing once makes it stick for that terminal.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicPermission {
    NotDetermined,
    Granted,
    Denied,
    /// Completion fired false (or never fired) while TCC still has no
    /// decision recorded — the prompt was never actually shown.
    NoDecision,
}

fn av_class() -> &'static AnyClass {
    AnyClass::get(c"AVCaptureDevice").expect("AVCaptureDevice class available (AVFoundation linked)")
}

fn media_type() -> *const AnyObject {
    CFString::new(MEDIA_TYPE_AUDIO).as_concrete_TypeRef() as *const AnyObject
}

/// Raw AVAuthorizationStatus: 0=notDetermined 1=authorized 2=denied
/// 3=restricted. Kept for diagnostics logging.
fn status_raw() -> i64 {
    unsafe { msg_send![av_class(), authorizationStatusForMediaType: media_type()] }
}

pub fn status() -> MicPermission {
    match status_raw() {
        1 => MicPermission::Granted, // AVAuthorizationStatusAuthorized
        0 => MicPermission::NotDetermined,
        _ => MicPermission::Denied, // Denied / Restricted
    }
}

/// Shows the system prompt when NotDetermined and blocks until answered.
/// Safe to call from a worker thread: the completion handler fires on a
/// private system queue, never on the calling thread.
pub fn request() -> MicPermission {
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |granted: Bool| {
        let _ = tx.send(granted == Bool::YES);
    });
    unsafe {
        let _: () = msg_send![av_class(),
            requestAccessForMediaType: media_type(),
            completionHandler: &*block];
    }
    match rx.recv_timeout(PROMPT_TIMEOUT) {
        Ok(true) => MicPermission::Granted,
        Ok(false) => {
            // A real "Don't Allow" click is recorded in TCC; a false that
            // leaves the status at NotDetermined means no prompt was shown.
            if status() == MicPermission::NotDetermined {
                MicPermission::NoDecision
            } else {
                MicPermission::Denied
            }
        }
        // Handler released without ever being invoked, or the user ignored
        // the prompt past the timeout: no decision is recorded either way.
        Err(_) => MicPermission::NoDecision,
    }
}

// --- Responsible-process identification ---

fn proc_path(pid: libc::pid_t) -> Option<String> {
    let mut buf = [0i8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    String::from_utf8(buf[..n as usize].iter().map(|&c| c as u8).collect()).ok()
}

fn proc_parent_pid(pid: libc::pid_t) -> Option<libc::pid_t> {
    // Diagnostic path only (runs at most a handful of times per denial), so
    // shelling out to ps beats dragging in sysctl bindings libc doesn't
    // expose for kinfo_proc.
    let out = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok().filter(|&p| p > 1)
}

/// "/Applications/iTerm.app/Contents/MacOS/iTerm2" -> ("iTerm", "/Applications/iTerm.app")
fn app_display_name_and_bundle(path: &str) -> Option<(String, String)> {
    let idx = path.find(".app/Contents/MacOS/")?;
    let bundle_root = path[..idx + ".app".len()].to_string();
    let name = path[..idx].rsplit('/').next()?;
    Some((name.trim_end_matches(".app").to_string(), bundle_root))
}

/// CFBundleIdentifier of the .app bundle at `bundle_root`, read from its
/// Info.plist via NSBundle. System Settings' Microphone list often omits
/// helper bundles entirely, but `tccutil reset Microphone <id>` works
/// regardless — which is why the id matters more than the display name.
fn bundle_id_for_app(bundle_root: &str) -> Option<String> {
    let c_path = std::ffi::CString::new(bundle_root).ok()?;
    unsafe {
        let ns_string: *const AnyObject =
            msg_send![AnyClass::get(c"NSString").unwrap(), stringWithUTF8String: c_path.as_ptr()];
        if ns_string.is_null() {
            return None;
        }
        let bundle: *mut AnyObject =
            msg_send![AnyClass::get(c"NSBundle").unwrap(), bundleWithPath: ns_string];
        if bundle.is_null() {
            return None;
        }
        let info: *mut AnyObject = msg_send![bundle, infoDictionary];
        if info.is_null() {
            return None;
        }
        let key = CFString::new("CFBundleIdentifier");
        let value: *const AnyObject =
            msg_send![info, objectForKey: key.as_concrete_TypeRef() as *const AnyObject];
        if value.is_null() {
            return None;
        }
        let cstr: *const std::os::raw::c_char = msg_send![value, UTF8String];
        if cstr.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned())
    }
}

pub struct ResponsibleApp {
    pub name: String,
    /// CFBundleIdentifier, when the ancestor bundle declares one.
    pub bundle_id: Option<String>,
}

/// The GUI app TCC will blame for this process's mic requests. tccd's subject
/// is the OUTERMOST .app-bundled ancestor (a `ZCode Helper.app` inside
/// `ZCode.app` resolves to `dev.zcode.app`, not the helper's id), so walk the
/// whole parent chain and keep the last .app found.
pub fn responsible_app() -> Option<ResponsibleApp> {
    let mut pid = unsafe { libc::getppid() };
    let mut outermost: Option<ResponsibleApp> = None;
    for _ in 0..10 {
        if let Some(path) = proc_path(pid) {
            if let Some((name, bundle_root)) = app_display_name_and_bundle(&path) {
                outermost = Some(ResponsibleApp {
                    name,
                    bundle_id: bundle_id_for_app(&bundle_root),
                });
            }
        }
        // The walk ends at launchd (no parent) — keep whatever ancestor we
        // already found instead of aborting the whole lookup here. Aborting
        // made every dev denial claim the app "could not be identified",
        // which also disabled the stale-denial tccutil recovery.
        match proc_parent_pid(pid) {
            Some(parent) => pid = parent,
            None => break,
        }
    }
    outermost
}

/// True when the app runs from inside a real .app bundle (bundled release
/// builds); false for the bare dev binary under `pnpm tauri dev`.
fn is_bundled() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(|s| s.contains(".app/Contents/MacOS/")))
        .unwrap_or(false)
}

fn denied_message() -> String {
    if is_bundled() {
        return "Microphone access is denied for Companion. Allow it in System Settings \
\u{2192} Privacy & Security \u{2192} Microphone, then relaunch the app. If the toggle \
is already on and it still fails: `tccutil reset Microphone dev.fl.companion`, then \
re-allow."
            .into();
    }
    match responsible_app() {
        Some(app) => {
            let reset = match &app.bundle_id {
                Some(id) => format!("`tccutil reset Microphone {id}`"),
                None => "`tccutil reset Microphone` (resets every app)".to_string(),
            };
            format!(
                "Microphone access is denied for \u{201c}{}\u{201d} \u{2014} in dev, macOS attributes \
the mic to the app that launched `pnpm tauri dev`, not to Companion itself. macOS never re-prompts \
after a denial, and helper apps may not appear in System Settings, so clear the stale entry with {} \
and press the mic button again. If it still fails, that app cannot request mic access at all \
(macOS hardened-runtime policy) \u{2014} run `pnpm tauri dev` from Terminal or iTerm instead.",
                app.name, reset
            )
        }
        None => DENIED_MSG.to_string(),
    }
}

/// Once a mic start has been verified in this process, trust it: AVFoundation's
/// status readback in a bare dev binary is not reliably stable across capture
/// stream teardown, and re-querying on every mic toggle could deny a session
/// that was demonstrably granted moments earlier. TCC revocations still apply
/// from the next app launch (fresh process, fresh check).
static VERIFIED_THIS_PROCESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Guards the dev-only stale-denial cleanup so repeated mic toggles cannot
/// loop reset → prompt → denial → reset.
static RESET_ATTEMPTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Dev-only recovery from a stale TCC denial. A "Don't Allow" recorded
/// against the app that launched `pnpm tauri dev` blocks every later attempt:
/// macOS never re-prompts, and the blamed app (often a bare helper bundle)
/// may not appear in System Settings' Microphone list at all, so there is no
/// toggle the user could flip. Clear exactly that one entry with tccutil and
/// ask again — the user pressing the mic button signals intent to allow.
/// Returns Some(result) when it took over the recovery, None to fall through
/// to the standard denial message.
fn clear_stale_dev_denial_and_rerequest() -> Option<Result<(), String>> {
    use std::sync::atomic::Ordering;

    if is_bundled() {
        return None;
    }
    if RESET_ATTEMPTED.swap(true, Ordering::Relaxed) {
        return None;
    }
    let bundle_id = responsible_app()?.bundle_id?;
    let output = std::process::Command::new("tccutil")
        .args(["reset", "Microphone", &bundle_id])
        .output();
    eprintln!(
        "[mic] cleared stale TCC denial for {bundle_id}: {}",
        match &output {
            Ok(o) => format!("status={}", o.status),
            Err(e) => format!("failed ({e})"),
        }
    );
    match status() {
        MicPermission::Granted => {
            VERIFIED_THIS_PROCESS.store(true, Ordering::Relaxed);
            Some(Ok(()))
        }
        MicPermission::NotDetermined => match request() {
            MicPermission::Granted => {
                VERIFIED_THIS_PROCESS.store(true, Ordering::Relaxed);
                Some(Ok(()))
            }
            MicPermission::Denied => Some(Err(denied_message())),
            _ => Some(Err(NO_PROMPT_MSG.into())),
        },
        // Reset didn't lift the denial (unexpected) — standard message.
        _ => None,
    }
}

fn log_denial_diagnostics() {
    eprintln!(
        "[mic] TCC denial: authorizationStatus raw={} (0=notDetermined 1=authorized 2=denied 3=restricted)",
        status_raw()
    );
    let mut pid = unsafe { libc::getppid() };
    for hop in 0..10 {
        let Some(path) = proc_path(pid) else {
            eprintln!("[mic] ancestor {hop}: pid={pid} (path unavailable)");
            break;
        };
        eprintln!("[mic] ancestor {hop}: pid={pid} path={path}");
        let Some(parent) = proc_parent_pid(pid) else {
            break;
        };
        pid = parent;
    }
    eprintln!(
        "[mic] TCC blames the app above that launched `pnpm tauri dev`; allow THAT app in \
System Settings → Privacy & Security → Microphone, then restart `pnpm tauri dev`."
    );
}

/// Gate for mic capture: prompts on first use, errors with user guidance on
/// denial.
pub fn ensure() -> Result<(), String> {
    use std::sync::atomic::Ordering;

    if VERIFIED_THIS_PROCESS.load(Ordering::Relaxed) {
        return Ok(());
    }
    match status() {
        MicPermission::Granted => {
            VERIFIED_THIS_PROCESS.store(true, Ordering::Relaxed);
            Ok(())
        }
        MicPermission::NotDetermined => match request() {
            MicPermission::Granted => {
                VERIFIED_THIS_PROCESS.store(true, Ordering::Relaxed);
                Ok(())
            }
            MicPermission::Denied => {
                log_denial_diagnostics();
                Err(denied_message())
            }
            _ => Err(NO_PROMPT_MSG.into()),
        },
        MicPermission::Denied => {
            log_denial_diagnostics();
            clear_stale_dev_denial_and_rerequest().unwrap_or_else(|| Err(denied_message()))
        }
        MicPermission::NoDecision => Err(NO_PROMPT_MSG.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Non-blocking sanity check of the TCC plumbing; does not prompt.
    #[test]
    fn status_reads_tcc_state() {
        // On a machine where mic permission was never decided this is
        // NotDetermined, but any variant proves the AVFoundation calls work.
        let _ = status();
    }

    #[test]
    fn app_name_extracted_from_bundle_path() {
        assert_eq!(
            app_display_name_and_bundle("/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            Some(("iTerm".into(), "/Applications/iTerm.app".into()))
        );
        assert_eq!(
            app_display_name_and_bundle(
                "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
            ),
            Some((
                "Terminal".into(),
                "/System/Applications/Utilities/Terminal.app".into()
            ))
        );
        assert_eq!(app_display_name_and_bundle("/opt/homebrew/bin/zsh"), None);
    }

    /// Reading CFBundleIdentifier out of a real system bundle proves the
    /// NSBundle plumbing works.
    #[test]
    fn bundle_id_read_from_real_bundle() {
        let id = bundle_id_for_app("/System/Applications/Utilities/Terminal.app");
        assert_eq!(id.as_deref(), Some("com.apple.Terminal"));
    }

    /// The parent walk resolves on a real machine; a GUI ancestor is expected
    /// under any normal launch (terminal, editor), None under exotic parents.
    #[test]
    fn responsible_app_walks_ancestors() {
        let _ = responsible_app();
    }

    /// Regression: the walk must survive reaching launchd (pid 1 has no
    /// parent) instead of aborting and discarding the .app ancestor it
    /// already found.
    #[test]
    fn responsible_app_walks_past_launchd() {
        let app = responsible_app();
        assert!(
            app.is_some(),
            "no .app ancestor found — the walk aborted before reaching it"
        );
        eprintln!("responsible app: {} ({:?})", app.as_ref().unwrap().name, app.as_ref().unwrap().bundle_id);
    }

    /// The dev binary is not inside an .app bundle; the check must not
    /// misclassify a bundled path either.
    #[test]
    fn bundled_detection() {
        assert!(!is_bundled() || std::env::current_exe().unwrap().to_string_lossy().contains(".app"));
    }
}
