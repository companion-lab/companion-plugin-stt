//! Windows load smoke test: mirrors the app's plugin-host loading pattern.
//!
//! The backend cdylib links moonshine's static archives, which themselves
//! import `onnxruntime.dll`. DLL search paths do not include the plugin's
//! directory, so the host resolves it by pre-loading each sidecar by absolute
//! path before loading the backend (import tables resolve against
//! already-loaded modules first). This test reproduces that staging in a
//! fresh temp dir: if the sidecar story breaks (DLL missing from the build,
//! wrong import name, etc.) the load fails here on CI instead of only at
//! runtime on a user machine.

#![cfg(target_os = "windows")]

use companion_plugin_sdk::ABI_VERSION;
use libloading::Library;
use std::path::PathBuf;

/// `target/{profile}` — the test binary lives in its `deps` subdir.
fn profile_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.parent().map(std::path::Path::to_path_buf))
        .expect("current_exe must have a profile dir parent")
}

/// LoadLibrary on a freshly-copied DLL can transiently fail while Windows
/// Defender/SmartScreen scans the new file (observed as flaky CI failures on
/// an unchanged commit). Retry with backoff before giving up.
fn load_with_retry(path: &std::path::Path) -> Library {
    const ATTEMPTS: u32 = 6;
    const DELAY: std::time::Duration = std::time::Duration::from_millis(1500);
    let mut last_err = None;
    for attempt in 1..=ATTEMPTS {
        match unsafe { Library::new(path) } {
            Ok(lib) => return lib,
            Err(e) => {
                eprintln!(
                    "  load attempt {attempt}/{ATTEMPTS} failed for {}: {e}",
                    path.display()
                );
                last_err = Some(e);
                if attempt < ATTEMPTS {
                    std::thread::sleep(DELAY);
                }
            }
        }
    }
    panic!(
        "loading {} failed after {ATTEMPTS} attempts: {}",
        path.display(),
        last_err.unwrap()
    );
}

#[test]
fn backend_loads_with_sidecar_preload() {
    let profile = profile_dir();
    let mut backend_dll: Option<PathBuf> = None;
    let mut sidecars: Vec<PathBuf> = Vec::new();
    for entry in std::fs::read_dir(&profile).expect("read target dir") {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(".dll") {
            continue;
        }
        if name.contains("backend") {
            backend_dll = Some(entry.path());
        } else {
            sidecars.push(entry.path());
        }
    }
    // Diagnostics ride in the step summary (the raw CI job log is auth-gated).
    eprintln!("profile dir: {}", profile.display());
    eprintln!("backend dll: {:?}", backend_dll);
    eprintln!("sidecar dlls: {:?}", sidecars);
    let backend_dll =
        backend_dll.expect("built backend cdylib not found in target dir (see eprintln above)");

    // Stage exactly what a plugin zip hands the app: the backend lib plus
    // its sidecars, in a directory on no DLL search path.
    let tmp = std::env::temp_dir().join(format!("stt-load-smoke-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("create staging dir");
    let staged_backend = tmp.join(backend_dll.file_name().unwrap());
    eprintln!("backend dll source: {:?}", backend_dll);
    std::fs::copy(&backend_dll, &staged_backend).expect("copy backend cdylib");
    let mut staged_sidecars = Vec::new();
    for path in &sidecars {
        let dst = tmp.join(path.file_name().unwrap());
        std::fs::copy(path, &dst).expect("copy sidecar dll");
        staged_sidecars.push(dst);
    }

    // Pre-load sidecars by absolute path first, then load the backend — the
    // import table's onnxruntime.dll reference resolves to the staged copy.
    let mut preload = Vec::new();
    for path in &staged_sidecars {
        let lib = load_with_retry(path);
        preload.push(lib);
    }
    let lib = load_with_retry(&staged_backend);

    let abi: libloading::Symbol<extern "C" fn() -> u32> =
        unsafe { lib.get(b"companion_plugin_abi_version") }.expect("abi symbol");
    assert_eq!(abi(), ABI_VERSION, "ABI version must match the host SDK");

    // Backends are never unloaded while the app runs; keep the images alive
    // too so the test never tears down a loaded DLL.
    std::mem::forget(lib);
    std::mem::forget(preload);
}
