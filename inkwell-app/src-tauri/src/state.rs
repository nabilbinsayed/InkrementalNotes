use std::sync::{Arc, Mutex};
use std::sync::mpsc::Sender;
use std::collections::HashMap;
use inkwell_core::{Document, wal::WalEntry};
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
    pub bgra_bytes: Arc<Vec<u8>>,
    pub bitmap_w: u32,
    pub bitmap_h: u32,
}

pub struct PageBitmapLruCache {
    pub entries: Vec<CachedPageBitmap>,
    pub max_entries: usize,
}

impl PageBitmapLruCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: Vec::with_capacity(max_entries),
            max_entries,
        }
    }

    pub fn get(&mut self, page: u32, target_w: i32, target_h: i32) -> Option<(Arc<Vec<u8>>, u32, u32)> {
        if let Some(pos) = self.entries.iter().position(|c| c.page == page && c.target_w == target_w && c.target_h == target_h) {
            let item = self.entries.remove(pos);
            let res = (item.bgra_bytes.clone(), item.bitmap_w, item.bitmap_h);
            self.entries.push(item);
            Some(res)
        } else {
            None
        }
    }

    pub fn put(&mut self, entry: CachedPageBitmap) {
        if let Some(pos) = self.entries.iter().position(|c| c.page == entry.page && c.target_w == entry.target_w && c.target_h == entry.target_h) {
            self.entries.remove(pos);
        } else if self.entries.len() >= self.max_entries {
            self.entries.remove(0); // Evict oldest
        }
        self.entries.push(entry);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

pub struct DocumentSession {
    pub doc: Document,
    pub pdf_path: Option<PathBuf>,
    pub pdf_bytes: Option<Arc<Vec<u8>>>,
    pub original_pdf_bytes: Option<Arc<Vec<u8>>>,
    pub wal: Option<Sender<WalOp>>,
    pub page_bitmap_cache: PageBitmapLruCache,
    pub page_dimensions: HashMap<u32, (f64, f64)>,
}

pub struct AppState {
    pub doc: Mutex<Option<Document>>,
    pub pdf_path: Mutex<Option<PathBuf>>,
    pub pdf_bytes: Mutex<Option<Arc<Vec<u8>>>>,
    /// Pristine bytes from the originally opened file. Never mutated by save
    /// cycles. Used as the base for image embedding to prevent compounding
    /// duplicate image objects across repeated saves.
    pub original_pdf_bytes: Mutex<Option<Arc<Vec<u8>>>>,
    pub wal: Mutex<Option<Sender<WalOp>>>,
    /// Cached PDFium instance — initialized once at startup.
    /// All commands borrow this instead of calling init_pdfium() per call.
    pub pdfium: Mutex<Option<Pdfium>>,
    /// Multi-page in-memory LRU cache for rendered full-page PDFium bitmaps
    /// to avoid redundant page rasterization across tiles on active/split/adjacent pages.
    pub page_bitmap_cache: Mutex<PageBitmapLruCache>,
    /// Pre-extracted page dimensions (width_pt, height_pt) for instant tile bounds calculation.
    pub page_dimensions: Mutex<HashMap<u32, (f64, f64)>>,
    /// Multi-document session map for tab switching and isolation
    pub sessions: Mutex<HashMap<String, DocumentSession>>,
    pub active_session_id: Mutex<Option<String>>,
    pub is_dirty: std::sync::atomic::AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            doc: Mutex::new(None),
            pdf_path: Mutex::new(None),
            pdf_bytes: Mutex::new(None),
            original_pdf_bytes: Mutex::new(None),
            wal: Mutex::new(None),
            pdfium: Mutex::new(None),
            page_bitmap_cache: Mutex::new(PageBitmapLruCache::new(16)),
            page_dimensions: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            active_session_id: Mutex::new(None),
            is_dirty: std::sync::atomic::AtomicBool::new(false),
        }
    }
}




