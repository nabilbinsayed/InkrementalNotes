use std::sync::Mutex;
use std::sync::mpsc::Sender;
use inkwell_core::{Document, tiles::TileCache, wal::WalEntry};
use std::path::PathBuf;
use inkwell_pdf::Pdfium;

pub enum WalOp {
    Append(WalEntry),
    Truncate,
    Close,
}

pub struct CachedPageBitmap {
    pub page: u32,
    pub target_w: i32,
    pub target_h: i32,
    pub bgra_bytes: Vec<u8>,
    pub bitmap_w: u32,
    pub bitmap_h: u32,
}

pub struct AppState {
    pub doc: Mutex<Option<Document>>,
    pub pdf_path: Mutex<Option<PathBuf>>,
    pub pdf_bytes: Mutex<Option<Vec<u8>>>,
    #[allow(dead_code)]
    pub tile_cache: Mutex<TileCache>,
    pub wal: Mutex<Option<Sender<WalOp>>>,
    /// Cached PDFium instance — initialized once at startup.
    /// All commands borrow this instead of calling init_pdfium() per call.
    pub pdfium: Mutex<Option<Pdfium>>,
    /// In-memory cache for the most recently rendered full-page PDFium bitmap
    /// to avoid 16x redundant page rasterization across tiles on the same page.
    pub page_bitmap_cache: Mutex<Option<CachedPageBitmap>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            doc: Mutex::new(None),
            pdf_path: Mutex::new(None),
            pdf_bytes: Mutex::new(None),
            tile_cache: Mutex::new(TileCache::new(256 * 1024 * 1024)), // 256 MB budget
            wal: Mutex::new(None),
            pdfium: Mutex::new(None),
            page_bitmap_cache: Mutex::new(None),
        }
    }
}


