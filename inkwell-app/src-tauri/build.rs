use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // Auto-copy platform-specific PDFium shared library into the cargo output directory (target/{profile}/)
    // so the app can find it at runtime without manual setup.
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace_root = manifest_dir.join("..").join("..");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let lib_filename = match target_os.as_str() {
        "linux" => "libpdfium.so",
        "macos" => "libpdfium.dylib",
        _ => "pdfium.dll",
    };

    let src_lib = workspace_root.join("bin").join(lib_filename);

    // OUT_DIR is something like target/debug/build/inkwell-app-<hash>/out
    // We want target/debug/ or target/release/ — go up three levels from OUT_DIR.
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("OUT_DIR has unexpected depth")
        .to_path_buf();
    let dst_lib = profile_dir.join(lib_filename);

    if src_lib.exists() && !dst_lib.exists() {
        if let Err(e) = std::fs::copy(&src_lib, &dst_lib) {
            // Non-fatal: warn but don't break the build.
            println!(
                "cargo:warning=Could not copy {lib_filename} from {:?} to {:?}: {}",
                src_lib, dst_lib, e
            );
        } else {
            println!(
                "cargo:warning=Copied {lib_filename} to {:?}",
                dst_lib
            );
        }
    }

    // Re-run this script if source libraries or any frontend files in ../src change.
    println!("cargo:rerun-if-changed=../../bin/pdfium.dll");
    println!("cargo:rerun-if-changed=../../bin/libpdfium.so");
    println!("cargo:rerun-if-changed=../../bin/libpdfium.dylib");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../src/index.html");
    println!("cargo:rerun-if-changed=../src/styles.css");
    println!("cargo:rerun-if-changed=../src/js");
}
