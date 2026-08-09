use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // Auto-copy pdfium.dll into the cargo output directory (target/{profile}/)
    // so the app can find it at runtime without manual setup.
    // Source: <workspace_root>/bin/pdfium.dll  (gitignored but present locally)
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // manifest_dir = inkwell-app/src-tauri
    // workspace root is two levels up
    let workspace_root = manifest_dir.join("..").join("..");
    let src_dll = workspace_root.join("bin").join("pdfium.dll");

    // OUT_DIR is something like target/debug/build/inkwell-app-<hash>/out
    // We want target/debug/ or target/release/ — go up three levels from OUT_DIR.
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("OUT_DIR has unexpected depth")
        .to_path_buf();
    let dst_dll = profile_dir.join("pdfium.dll");

    if src_dll.exists() && !dst_dll.exists() {
        if let Err(e) = std::fs::copy(&src_dll, &dst_dll) {
            // Non-fatal: warn but don't break the build.
            println!(
                "cargo:warning=Could not copy pdfium.dll from {:?} to {:?}: {}",
                src_dll, dst_dll, e
            );
        } else {
            println!(
                "cargo:warning=Copied pdfium.dll to {:?}",
                dst_dll
            );
        }
    }

    // Re-run this script if source DLL or any frontend files in ../src change.
    println!("cargo:rerun-if-changed=../../bin/pdfium.dll");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../src/index.html");
    println!("cargo:rerun-if-changed=../src/styles.css");
    println!("cargo:rerun-if-changed=../src/js/app.js");
    println!("cargo:rerun-if-changed=../src/js/viewport.js");
    println!("cargo:rerun-if-changed=../src/js/ink.js");
    println!("cargo:rerun-if-changed=../src/js/hud.js");
}
