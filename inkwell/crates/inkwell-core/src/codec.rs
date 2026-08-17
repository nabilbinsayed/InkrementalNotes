//! Sidecar codec: the compact binary encoding for stroke sample data.
//!
//! Measured in the Python proof at ~3.1 bytes/sample without timestamps.
//! This implementation keeps timestamps (as quantised deltas) and still lands
//! close to 4 bytes/sample, which puts a densely handwritten page at a couple
//! of hundred KB. See `tests/integration.rs` for the measured figure.
//!
//! Format (all integers zigzag LEB128 unless stated):
//!   magic     "IWSC"
//!   u8        version = 1
//!   varint    stroke count
//!   per stroke:
//!     16 bytes  id (big-endian u128)
//!     u8        tool kind
//!     3 x u8    rgb
//!     varint    base_width  * 100
//!     varint    gamma       * 1000
//!     varint    min_ratio   * 1000
//!     varint    sample count
//!     per sample:
//!       varint  dx  (quantised 1/QUANT pt, delta)
//!       varint  dy
//!       varint  dp  (1/PQUANT, delta)
//!       varint  dt  (0.1 ms units, delta)
//!
//! Pressure is stored at 10-bit resolution as a *delta*, not as a raw byte.
//! Windows Ink delivers pressure normalised to 0..1024, so a single byte would
//! silently discard two bits of real device data. Because consecutive pressure
//! samples differ by very little, the zigzag varint of the delta almost always
//! occupies one byte anyway -- so full fidelity costs essentially nothing.
//! (An earlier revision used a raw u8 here; the round-trip test caught it by
//! showing 746 distinct source levels collapsing to 229.)

use crate::ink::{Brush, Sample, Stroke, ToolKind};

pub const MAGIC: &[u8; 4] = b"IWSC";
pub const VERSION: u8 = 1;
/// Spatial quantisation: 1/50 pt ~= 0.007 mm. Far below what any pen resolves.
pub const QUANT: f64 = 50.0;
/// Temporal quantisation: 0.1 ms.
pub const TQUANT: f64 = 10.0;
/// Pressure quantisation: 10 bits, matching the Windows Ink 0..1024 range.
pub const PQUANT: f64 = 1023.0;

#[derive(Debug)]
pub enum CodecError {
    BadMagic,
    UnsupportedVersion(u8),
    Truncated,
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodecError::BadMagic => write!(f, "not an Inkwell stroke payload"),
            CodecError::UnsupportedVersion(v) => write!(f, "unsupported codec version {v}"),
            CodecError::Truncated => write!(f, "payload truncated"),
        }
    }
}

impl std::error::Error for CodecError {}

// --- varint ---------------------------------------------------------------

fn zigzag(n: i64) -> u64 {
    ((n << 1) ^ (n >> 63)) as u64
}

fn unzigzag(n: u64) -> i64 {
    ((n >> 1) as i64) ^ -((n & 1) as i64)
}

pub fn put_uvarint(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let b = (n & 0x7F) as u8;
        n >>= 7;
        out.push(if n != 0 { b | 0x80 } else { b });
        if n == 0 {
            break;
        }
    }
}

pub fn put_varint(out: &mut Vec<u8>, n: i64) {
    put_uvarint(out, zigzag(n));
}

pub fn get_uvarint(buf: &[u8], pos: &mut usize) -> Result<u64, CodecError> {
    let mut n = 0u64;
    let mut shift = 0u32;
    loop {
        let b = *buf.get(*pos).ok_or(CodecError::Truncated)?;
        *pos += 1;
        if shift >= 64 || (shift == 63 && (b & 0x7F) > 1) {
            return Err(CodecError::Truncated);
        }
        n |= ((b & 0x7F) as u64) << shift;
        if b & 0x80 == 0 {
            return Ok(n);
        }
        shift += 7;
    }
}

pub fn get_varint(buf: &[u8], pos: &mut usize) -> Result<i64, CodecError> {
    Ok(unzigzag(get_uvarint(buf, pos)?))
}

// --- encode / decode ------------------------------------------------------

pub fn encode(strokes: &[Stroke]) -> Vec<u8> {
    let mut out = Vec::with_capacity(strokes.len() * 512);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    put_uvarint(&mut out, strokes.len() as u64);

    for s in strokes {
        out.extend_from_slice(&s.id.to_be_bytes());
        out.push(s.kind.as_u8());
        for c in s.rgb {
            out.push((c.clamp(0.0, 1.0) * 255.0).round() as u8);
        }
        put_uvarint(&mut out, (s.brush.base_width * 100.0).round().max(0.0) as u64);
        put_uvarint(&mut out, (s.brush.gamma * 1000.0).round().max(0.0) as u64);
        put_uvarint(&mut out, (s.brush.min_ratio * 1000.0).round().max(0.0) as u64);
        put_uvarint(&mut out, s.samples.len() as u64);

        let (mut px, mut py, mut pp, mut pt) = (0i64, 0i64, 0i64, 0i64);
        for sm in &s.samples {
            let ix = (sm.x * QUANT).round() as i64;
            let iy = (sm.y * QUANT).round() as i64;
            let ip = (sm.p.clamp(0.0, 1.0) * PQUANT).round() as i64;
            let it = (sm.t * TQUANT).round() as i64;
            put_varint(&mut out, ix - px);
            put_varint(&mut out, iy - py);
            put_varint(&mut out, ip - pp);
            put_varint(&mut out, it - pt);
            px = ix;
            py = iy;
            pp = ip;
            pt = it;
        }
    }
    out
}

pub fn decode(buf: &[u8]) -> Result<Vec<Stroke>, CodecError> {
    if buf.len() < 5 || &buf[0..4] != MAGIC {
        return Err(CodecError::BadMagic);
    }
    if buf[4] != VERSION {
        return Err(CodecError::UnsupportedVersion(buf[4]));
    }
    let mut pos = 5usize;
    let count = get_uvarint(buf, &mut pos)? as usize;
    let mut out = Vec::with_capacity(count.min(1024));

    for _ in 0..count {
        let idb: [u8; 16] = buf
            .get(pos..pos + 16)
            .ok_or(CodecError::Truncated)?
            .try_into()
            .map_err(|_| CodecError::Truncated)?;
        pos += 16;
        let id = u128::from_be_bytes(idb);
        let kind = ToolKind::from_u8(*buf.get(pos).ok_or(CodecError::Truncated)?);
        pos += 1;
        let mut rgb = [0.0f64; 3];
        for c in rgb.iter_mut() {
            *c = *buf.get(pos).ok_or(CodecError::Truncated)? as f64 / 255.0;
            pos += 1;
        }
        let brush = Brush {
            base_width: get_uvarint(buf, &mut pos)? as f64 / 100.0,
            gamma: get_uvarint(buf, &mut pos)? as f64 / 1000.0,
            min_ratio: get_uvarint(buf, &mut pos)? as f64 / 1000.0,
        };
        let n = get_uvarint(buf, &mut pos)? as usize;

        let mut samples = Vec::with_capacity(n.min(1024));
        let (mut px, mut py, mut pp, mut pt) = (0i64, 0i64, 0i64, 0i64);
        for _ in 0..n {
            px += get_varint(buf, &mut pos)?;
            py += get_varint(buf, &mut pos)?;
            pp += get_varint(buf, &mut pos)?;
            pt += get_varint(buf, &mut pos)?;
            samples.push(Sample {
                x: px as f64 / QUANT,
                y: py as f64 / QUANT,
                p: (pp as f64 / PQUANT).clamp(0.0, 1.0),
                t: pt as f64 / TQUANT,
            });
        }
        out.push(Stroke { id, kind, rgb, brush, samples });
    }
    Ok(out)
}
