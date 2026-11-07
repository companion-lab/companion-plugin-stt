//! Build script for the voice plugin backend.
//!
//! moonshine-sys links `@rpath/libmoonshine.dylib`. Its build script only
//! makes that resolvable inside `app/src-tauri/target` (where it copies the
//! dylib next to the host binary and the host's own rpaths pick it up). This
//! crate builds into its own `target/` and is loaded as a cdylib by the host,
//! so it needs an explicit rpath to the moonshine-sys lib dir for both the
//! test harness binaries and the deployed cdylib.
//!
//! It also links AVFoundation + Foundation: `mic_permission` messages
//! AVCaptureDevice / NSBundle via objc2, and outside the host app process
//! (e.g. `cargo test` harnesses) nothing else would have loaded those
//! frameworks, so `AnyClass::get` would come up empty.

use std::env;
use std::path::{Path, PathBuf};

/// Lexically resolve `..` components so the emitted rpath is a clean path.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

    if target_os == "macos" {
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=AVFoundation");

        let moonshine_lib = normalize(
            manifest_dir
                .join("../moonshine-sys/lib/macos-arm64")
                .as_path(),
        );
        if moonshine_lib.join("libmoonshine.dylib").exists() {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", moonshine_lib.display());
            println!("cargo:rerun-if-changed={}", moonshine_lib.display());
        }
        return;
    }

    // Linux / Windows: link against the moonshine prebuilt lib and set rpath
    // so the cdylib finds libmoonshine at runtime (mirrors moonshine-sys).
    let (lib_subdir, lib_name) = match target_os.as_str() {
        "linux" => ("linux-x86_64", "libmoonshine.so"),
        "windows" => ("windows-x86_64", "moonshine.dll"),
        _ => return,
    };
    let moonshine_lib = normalize(
        manifest_dir
            .join("../moonshine-sys/lib")
            .join(lib_subdir)
            .as_path(),
    );
    if !moonshine_lib.join(lib_name).exists() {
        // Libs not present (download-lib.sh not run) — skip; the build will
        // fail at link time with a clear "cannot find -lmoonshine" error.
        return;
    }
    println!("cargo:rustc-link-search=native={}", moonshine_lib.display());
    println!("cargo:rustc-link-lib=dylib=moonshine");
    if target_os == "linux" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", moonshine_lib.display());
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
    }
    println!("cargo:rerun-if-changed={}", moonshine_lib.display());
}
