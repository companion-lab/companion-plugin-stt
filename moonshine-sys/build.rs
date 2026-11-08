use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let header_path = crate_dir.join("moonshine-c-api.h");
    let lib_dir = crate_dir.join("lib");

    // Generate bindings with bindgen
    let bindings = bindgen::Builder::default()
        .header(header_path.to_str().unwrap())
        .clang_arg(format!("-I{}", crate_dir.display()))
        .allowlist_function("moonshine_.*")
        .allowlist_type("moonshine_.*")
        .allowlist_type("transcript_.*")
        .allowlist_type("speaker_span_t")
        .allowlist_var("MOONSHINE_.*")
        .layout_tests(false)
        .generate()
        .expect("Failed to generate bindings");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out_dir.join("bindings.rs"))
        .expect("Failed to write bindings");

    // Platform-specific linking
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();

    match (target_os.as_str(), target_arch.as_str()) {
        ("linux", "x86_64") => {
            let linux_lib = lib_dir.join("linux-x86_64");
            println!("cargo:rustc-link-search=native={}", linux_lib.display());
            println!("cargo:rustc-link-lib=dylib=moonshine");

            // Copy shared libs to target profile dir
            let profile_dir = crate_dir
                .join("..")
                .join("target")
                .join(env::var("PROFILE").unwrap_or_else(|_| "debug".into()));
            fs::create_dir_all(&profile_dir).ok();
            for entry in fs::read_dir(&linux_lib).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name();
                let _ = fs::copy(entry.path(), profile_dir.join(&name));
            }

            // Set rpath to the absolute path of the lib dir for dev builds
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", linux_lib.display());
            // Also set $ORIGIN for release builds (libs copied next to binary)
            println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        }
        ("linux", "aarch64") => {
            let linux_lib = lib_dir.join("linux-arm64");
            println!("cargo:rustc-link-search=native={}", linux_lib.display());
            println!("cargo:rustc-link-lib=dylib=moonshine");

            let profile_dir = crate_dir
                .join("..")
                .join("target")
                .join(env::var("PROFILE").unwrap_or_else(|_| "debug".into()));
            fs::create_dir_all(&profile_dir).ok();
            for entry in fs::read_dir(&linux_lib).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name();
                let _ = fs::copy(entry.path(), profile_dir.join(&name));
            }

            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", linux_lib.display());
            println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
        }
        ("macos", _) => {
            let mac_lib = lib_dir.join("macos-arm64");
            println!("cargo:rustc-link-search=native={}", mac_lib.display());
            println!("cargo:rustc-link-lib=dylib=moonshine");
            println!("cargo:rustc-link-lib=dylib=c++");
            println!("cargo:rustc-link-lib=framework=CoreFoundation");
            println!("cargo:rustc-link-lib=framework=Foundation");

            // Copy shared libs to target profile dir so they're next to the binary
            let profile_dir = crate_dir
                .join("..")
                .join("target")
                .join(env::var("PROFILE").unwrap_or_else(|_| "debug".into()));
            fs::create_dir_all(&profile_dir).ok();
            for entry in fs::read_dir(&mac_lib).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name();
                if name.to_string_lossy().ends_with(".dylib") {
                    let _ = fs::copy(entry.path(), profile_dir.join(&name));
                }
            }
        }
        ("windows", _) => {
            // The windows package has no moonshine.dll: moonshine ships as
            // static archives (moonshine.lib + moonshine-utils.lib +
            // ort-utils.lib + bin-tokenizer.lib) plus a dynamic onnxruntime
            // (onnxruntime.lib import lib + onnxruntime.dll). All must be
            // linked, or link.exe fails with unresolved moonshine/ORT
            // symbols. The download script renames the hyphenated archive
            // files to underscores so these -l names resolve.
            let win_lib = lib_dir.join("windows-x86_64");
            println!("cargo:rustc-link-search=native={}", win_lib.display());
            println!("cargo:rustc-link-lib=static=moonshine");
            println!("cargo:rustc-link-lib=static=moonshine_utils");
            println!("cargo:rustc-link-lib=static=ort_utils");
            println!("cargo:rustc-link-lib=static=bin_tokenizer");
            println!("cargo:rustc-link-lib=dylib=onnxruntime");

            // Copy DLLs next to the binary
            let profile_dir = crate_dir
                .join("..")
                .join("target")
                .join(env::var("PROFILE").unwrap_or_else(|_| "debug".into()));
            fs::create_dir_all(&profile_dir).ok();
            for entry in fs::read_dir(&win_lib).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name();
                let _ = fs::copy(entry.path(), profile_dir.join(&name));
            }
        }
        _ => {
            panic!("Unsupported platform: {} {}", target_os, target_arch);
        }
    }

    println!("cargo:rerun-if-changed=moonshine-c-api.h");
    println!("cargo:rerun-if-changed=build.rs");
}
