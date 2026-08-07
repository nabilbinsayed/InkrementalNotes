use std::sync::Mutex;
use inkwell_core::{Document, tiles::TileCache, wal::Wal};
use std::path::PathBuf;

pub struct AppState {
    pub doc: Mutex<Option<Document>>,
    pub pdf_path: Mutex<Option<PathBuf>>,
    pub pdf_bytes: Mutex<Option<Vec<u8>>>,
    #[allow(dead_code)]
    pub tile_cache: Mutex<TileCache>,
    pub wal: Mutex<Option<Wal>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            doc: Mutex::new(None),
            pdf_path: Mutex::new(None),
            pdf_bytes: Mutex::new(None),
            tile_cache: Mutex::new(TileCache::new(256 * 1024 * 1024)), // 256 MB budget
            wal: Mutex::new(None),
        }
    }
}
