pub mod images;
pub mod normalise;
pub mod outline;
pub mod rasterizer;
pub mod text;
pub mod text_embed;

pub use images::{embed_images_in_pdf, ImageAnnotation};
pub use normalise::normalise;
pub use outline::{extract_outline, TocItem};
pub use rasterizer::PdfiumRasterizer;
pub use text::{extract_text, extract_text_spans, extract_page_text_data, TextSpan, CharSpan, TextLine, PageTextData};
pub use text_embed::{embed_texts_in_pdf, TextAnnotation};

// Re-export core PDFium types so dependents don't need a direct pdfium_render dependency.
pub use pdfium_render::prelude::{Pdfium, PdfiumError};


#[cfg(target_os = "windows")]
const PDFIUM_FILENAMES: &[&str] = &["pdfium.dll"];

#[cfg(target_os = "linux")]
const PDFIUM_FILENAMES: &[&str] = &["libpdfium.so", "libpdfium.so.1"];

#[cfg(target_os = "macos")]
const PDFIUM_FILENAMES: &[&str] = &["libpdfium.dylib"];

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
const PDFIUM_FILENAMES: &[&str] = &["pdfium.dll", "libpdfium.so", "libpdfium.dylib"];

fn is_valid_pdfium_binary(path: &std::path::Path) -> bool {
    path.is_file() && path.metadata().map(|m| m.len() > 1024).unwrap_or(false)
}

fn find_pdfium_recursive(root: &std::path::Path, max_depth: usize) -> Option<std::path::PathBuf> {
    if max_depth == 0 || !root.is_dir() {
        return None;
    }
    for filename in PDFIUM_FILENAMES {
        let p = root.join(filename);
        if is_valid_pdfium_binary(&p) {
            return Some(p);
        }
    }
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if !name_str.starts_with('.') && name_str != "proc" && name_str != "sys" && name_str != "dev" {
                    if let Some(found) = find_pdfium_recursive(&path, max_depth - 1) {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

/// Initialize PDFium binding by checking absolute paths at executable directory, custom env var, or system library.
pub fn init_pdfium() -> Result<Pdfium, PdfiumError> {
    let mut candidate_paths = Vec::new();

    let mut add_dir_and_subdirs = |p: std::path::PathBuf| {
        candidate_paths.push(p.clone());
        candidate_paths.push(p.join("bin"));
        candidate_paths.push(p.join("lib"));
        candidate_paths.push(p.join("lib64"));
        candidate_paths.push(p.join("src-tauri"));
        candidate_paths.push(p.join("resources"));
        candidate_paths.push(p.join("resources").join("bin"));
        candidate_paths.push(p.join("resources").join("lib"));
        candidate_paths.push(p.join("lib").join("Inkwell"));
        candidate_paths.push(p.join("lib").join("inkwell"));
        candidate_paths.push(p.join("lib").join("Inkwell").join("resources"));
        candidate_paths.push(p.join("lib").join("Inkwell").join("resources").join("bin"));
        candidate_paths.push(p.join("_up_").join("_up_").join("bin"));
        candidate_paths.push(p.join("resources").join("_up_").join("_up_").join("bin"));
    };

    let mut search_roots = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        for _ in 0..6 {
            if let Some(dir) = cur {
                add_dir_and_subdirs(dir.to_path_buf());
                search_roots.push(dir.to_path_buf());
                cur = dir.parent();
            } else {
                break;
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        add_dir_and_subdirs(cwd.clone());
        search_roots.push(cwd.clone());
        if let Some(parent) = cwd.parent() {
            add_dir_and_subdirs(parent.to_path_buf());
            search_roots.push(parent.to_path_buf());
        }
    }

    if let Ok(custom_dir) = std::env::var("PDFIUM_DLL_DIR") {
        let p = std::path::PathBuf::from(custom_dir);
        add_dir_and_subdirs(p.clone());
        search_roots.push(p);
    }

    for dir in &candidate_paths {
        for filename in PDFIUM_FILENAMES {
            let lib_path = dir.join(filename);
            if is_valid_pdfium_binary(&lib_path) {
                match Pdfium::bind_to_library(&lib_path) {
                    Ok(bindings) => {
                        eprintln!("Successfully loaded PDFium library from {:?}", lib_path);
                        return Ok(Pdfium::new(bindings));
                    }
                    Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                        return Ok(Pdfium::default());
                    }
                    Err(error) => eprintln!("Failed to load PDFium from {lib_path:?}: {error:?}"),
                }
            }
        }
    }

    // Secondary recursive scan across discovered search roots
    for root in search_roots {
        if let Some(found_path) = find_pdfium_recursive(&root, 3) {
            match Pdfium::bind_to_library(&found_path) {
                Ok(bindings) => {
                    eprintln!("Successfully loaded PDFium library (recursive) from {:?}", found_path);
                    return Ok(Pdfium::new(bindings));
                }
                Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                    return Ok(Pdfium::default());
                }
                Err(error) => eprintln!("Failed to load PDFium from recursive find {found_path:?}: {error:?}"),
            }
        }
    }

    match Pdfium::bind_to_system_library() {
        Ok(bindings) => Ok(Pdfium::new(bindings)),
        Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => Ok(Pdfium::default()),
        Err(e) => Err(e),
    }
}

/// Initialize PDFium binding by probing a specific directory and its standard subdirectories.
pub fn init_pdfium_from_dir(dir: &std::path::Path) -> Result<Pdfium, PdfiumError> {
    let candidate_paths = [
        dir.to_path_buf(),
        dir.join("bin"),
        dir.join("lib"),
        dir.join("lib64"),
        dir.join("resources"),
        dir.join("resources").join("bin"),
        dir.join("resources").join("lib"),
        dir.join("_up_").join("_up_").join("bin"),
        dir.join("resources").join("_up_").join("_up_").join("bin"),
    ];

    for d in &candidate_paths {
        for filename in PDFIUM_FILENAMES {
            let lib_path = d.join(filename);
            if is_valid_pdfium_binary(&lib_path) {
                match Pdfium::bind_to_library(&lib_path) {
                    Ok(bindings) => {
                        eprintln!("Successfully loaded PDFium library from {:?}", lib_path);
                        return Ok(Pdfium::new(bindings));
                    }
                    Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                        return Ok(Pdfium::default());
                    }
                    Err(error) => eprintln!("Failed to load PDFium from {lib_path:?}: {error:?}"),
                }
            }
        }
    }

    // Fallback: deep recursive scan in dir up to depth 4
    if let Some(found_path) = find_pdfium_recursive(dir, 4) {
        match Pdfium::bind_to_library(&found_path) {
            Ok(bindings) => {
                eprintln!("Successfully loaded PDFium library (recursive from dir) from {:?}", found_path);
                return Ok(Pdfium::new(bindings));
            }
            Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                return Ok(Pdfium::default());
            }
            Err(error) => eprintln!("Failed to load PDFium from {found_path:?}: {error:?}"),
        }
    }

    Pdfium::bind_to_library(dir.join(PDFIUM_FILENAMES[0])).map(Pdfium::new)
}

