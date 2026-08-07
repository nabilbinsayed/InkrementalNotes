//! Write-ahead log: the thing that stops you losing work, without hammering
//! your cloud sync folder.
//!
//! Google Drive re-uploads an entire file on every change. Autosaving a 40 MB
//! PDF every ten seconds is user-hostile. So: every committed stroke appends a
//! few hundred bytes to a local journal (instant, fsynced), and the PDF itself
//! is only rewritten when the user actually pauses. On crash, the journal is
//! replayed. Zero data loss, zero sync thrash.
//!
//! Record layout, little-endian:
//!   u8    kind        1 = stroke added, 2 = stroke removed
//!   u32   payload len
//!   ..    payload
//!   u32   checksum of payload
//!
//! A torn final record fails its checksum and replay stops there, keeping
//! everything before it. Partial writes can never poison earlier entries.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::codec;
use crate::ink::Stroke;

const KIND_ADD: u8 = 1;
const KIND_REMOVE: u8 = 2;

#[derive(Debug, Clone, PartialEq)]
pub enum WalEntry {
    Added(Stroke),
    Removed(u128),
}

pub struct Wal {
    path: PathBuf,
    file: File,
    records: u64,
}

fn checksum(b: &[u8]) -> u32 {
    // FNV-1a. Not cryptographic; we only need to detect a torn tail.
    let mut h: u32 = 0x811C_9DC5;
    for &x in b {
        h ^= x as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

impl Wal {
    /// Open (creating if needed) the journal for a document.
    ///
    /// Keep this OUT of the user's synced folder -- a temp dir keyed by a hash of
    /// the document path is the right home, so the Drive folder stays clean.
    pub fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let file = OpenOptions::new().create(true).read(true).append(true).open(&path)?;
        Ok(Self { path, file, records: 0 })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn records_written(&self) -> u64 {
        self.records
    }

    pub fn append(&mut self, entry: &WalEntry) -> std::io::Result<()> {
        let (kind, payload) = match entry {
            WalEntry::Added(s) => (KIND_ADD, codec::encode(std::slice::from_ref(s))),
            WalEntry::Removed(id) => (KIND_REMOVE, id.to_be_bytes().to_vec()),
        };
        let mut rec = Vec::with_capacity(payload.len() + 9);
        rec.push(kind);
        rec.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        rec.extend_from_slice(&payload);
        rec.extend_from_slice(&checksum(&payload).to_le_bytes());

        self.file.write_all(&rec)?;
        // Durability is the entire point of this file. Do not remove.
        self.file.sync_data()?;
        self.records += 1;
        Ok(())
    }

    /// Replay every intact record. A torn final record is dropped silently --
    /// that is the expected outcome of a crash mid-append.
    pub fn replay(path: impl AsRef<Path>) -> std::io::Result<Vec<WalEntry>> {
        let mut buf = Vec::new();
        match File::open(path.as_ref()) {
            Ok(mut f) => {
                f.read_to_end(&mut buf)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        }

        let mut out = Vec::new();
        let mut i = 0usize;
        while i + 5 <= buf.len() {
            let kind = buf[i];
            let len = u32::from_le_bytes([buf[i + 1], buf[i + 2], buf[i + 3], buf[i + 4]]) as usize;
            let ps = i + 5;
            let pe = ps + len;
            let ce = pe + 4;
            if ce > buf.len() {
                break; // torn tail
            }
            let payload = &buf[ps..pe];
            let want = u32::from_le_bytes([buf[pe], buf[pe + 1], buf[pe + 2], buf[pe + 3]]);
            if checksum(payload) != want {
                break; // torn or corrupt tail
            }
            match kind {
                KIND_ADD => {
                    if let Ok(mut v) = codec::decode(payload) {
                        if let Some(s) = v.pop() {
                            out.push(WalEntry::Added(s));
                        }
                    }
                }
                KIND_REMOVE if len == 16 => {
                    let mut b = [0u8; 16];
                    b.copy_from_slice(payload);
                    out.push(WalEntry::Removed(u128::from_be_bytes(b)));
                }
                _ => break,
            }
            i = ce;
        }
        Ok(out)
    }

    /// Called after the PDF has been written successfully. Order matters:
    /// flush the PDF first, then truncate the journal. Never the other way.
    pub fn truncate(&mut self) -> std::io::Result<()> {
        let file = OpenOptions::new().create(true).write(true).truncate(true).open(&self.path)?;
        file.sync_all()?;
        self.file = OpenOptions::new().create(true).read(true).append(true).open(&self.path)?;
        self.records = 0;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// autosave policy
// ---------------------------------------------------------------------------

/// When to actually rewrite the PDF. Pure decision function, no clock and no
/// I/O, so it is testable without sleeping.
#[derive(Debug, Clone, Copy)]
pub struct FlushPolicy {
    /// Seconds of pen inactivity that count as "the user paused".
    pub idle_secs: f64,
    /// Hard ceiling between flushes, however busy the user is.
    pub max_interval_secs: f64,
}

impl Default for FlushPolicy {
    fn default() -> Self {
        Self { idle_secs: 20.0, max_interval_secs: 180.0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushReason {
    Idle,
    MaxInterval,
    FocusLost,
    Explicit,
    Closing,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FlushSignals {
    pub dirty: bool,
    pub focus_lost: bool,
    pub explicit: bool,
    pub closing: bool,
}

impl FlushPolicy {
    /// `since_input` / `since_flush` are seconds.
    pub fn decide(
        &self,
        sig: FlushSignals,
        since_input: f64,
        since_flush: f64,
    ) -> Option<FlushReason> {
        if !sig.dirty {
            return None;
        }
        if sig.closing {
            return Some(FlushReason::Closing);
        }
        if sig.explicit {
            return Some(FlushReason::Explicit);
        }
        if sig.focus_lost {
            return Some(FlushReason::FocusLost);
        }
        if since_input >= self.idle_secs {
            return Some(FlushReason::Idle);
        }
        if since_flush >= self.max_interval_secs {
            return Some(FlushReason::MaxInterval);
        }
        None
    }
}

/// Atomic replace: write to a sibling temp file, fsync, then rename over the
/// target. Never write in place -- a half-written PDF in a synced folder is how
/// people lose a semester of notes.
pub fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        ".{}.inkwell-tmp",
        target.file_name().and_then(|s| s.to_str()).unwrap_or("doc")
    ));
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, target)?;
    // fsync the directory so the rename itself is durable
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}
