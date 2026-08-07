//! # inkwell-core
//!
//! Document model, ink maths, the PDF-native file format, and crash-safe
//! autosave. **No UI, no windowing, no shell dependency** -- deliberately, so
//! that the choice between a Tauri shell and a native winit/wgpu shell stays
//! reversible without touching any of the correctness-critical code.
//!
//! ## The one idea this crate exists to implement
//!
//! Annotated ink lives inside a single, completely standard PDF, in three layers:
//!
//! | Layer | Content | Who reads it |
//! |-------|---------|--------------|
//! | 1 visual | variable-width ribbons as **filled** vector paths | every PDF reader in existence |
//! | 2 interop | `/Ink` annotations carrying `/AP` appearance streams | Acrobat, Okular, Xodo, Preview |
//! | 3 data | compressed sidecar embedded under private `/Inkw_*` keys | only Inkwell |
//!
//! Layer 1 exists because PDF's stroke operator has exactly one line width, so
//! pressure cannot be expressed with it. We offset the centreline by the
//! pressure-derived half-width on both sides and fill the resulting outline.
//!
//! Layer 3 exists because Layers 1 and 2 are lossy: neither can carry pressure,
//! timestamps, tool identity or layer structure. ISO 32000 guarantees that
//! conforming readers ignore dictionary keys they do not recognise, so the
//! editable data rides along invisibly. If another application ever strips it,
//! `read_sidecar` reports that and the app falls back to reconstructing strokes
//! from `/InkList` -- lossy, but never a hard failure.
//!
//! ## Example
//!
//! ```no_run
//! use inkwell_core::{doc::Document, ink::*, pdf::PdfFile};
//!
//! let mut document = Document::for_pdf(1);
//! let mut ids = IdGen::seeded(42);
//! let mut b = StrokeBuilder::new(ids.next_id(), ToolKind::Pen,
//!                                [0.0, 0.0, 0.0], Brush::default(), true);
//! for i in 0..200 {
//!     b.push(100.0 + i as f64, 500.0, 0.5, i as f64 * 4.3);
//! }
//! document.push_stroke(0, b.finish(0.3));
//!
//! let mut f = PdfFile::open(std::fs::read("lecture.pdf").unwrap()).unwrap();
//! f.write_document(&document, inkwell_core::pdf::DEFAULT_GROUP).unwrap();
//! inkwell_core::wal::atomic_write("lecture.pdf".as_ref(), &f.finish()).unwrap();
//! ```

pub mod codec;
pub mod doc;
pub mod ink;
pub mod pdf;
pub mod pdfobj;
pub mod tiles;
pub mod wal;

pub use doc::{Document, Sheet, SheetKind, Viewport};
pub use ink::{Brush, IdGen, Sample, Stroke, StrokeBuilder, ToolKind};
pub use pdf::{PdfFile, SidecarStatus};
pub use wal::{FlushPolicy, FlushReason, FlushSignals, Wal, WalEntry};

/// Format version written into `/Inkw_Ver`.
pub const FORMAT_VERSION: u32 = 1;
