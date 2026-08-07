//! A deliberately shallow PDF reader: just enough structure to perform
//! incremental updates without implementing a full parser.
//!
//! SCOPE AND HONEST LIMITATION
//! ---------------------------
//! This handles PDFs with **classic cross-reference tables**. PDFs written with
//! *cross-reference streams* and *object streams* (PDF 1.5+, which includes most
//! files produced by modern tools) store the catalog and page objects compressed
//! inside object streams, where byte-scanning cannot reach them.
//!
//! `PdfFile::open` detects that case and returns `Error::XrefStream` rather than
//! silently corrupting the file. The production answer is to normalise such
//! documents on import via PDFium (which decompresses object streams for us) and
//! then append. That belongs in the `inkwell-pdf` crate, not here.
//!
//! Everything in this module operates on bytes, never on `str`: PDF strings and
//! streams are not valid UTF-8 and lossy conversion would corrupt them.

#[derive(Debug)]
pub enum Error {
    NoStartxref,
    NoTrailer,
    NoRoot,
    NoSize,
    XrefStream,
    MissingObject(u32),
    Malformed(&'static str),
    Io(std::io::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NoStartxref => write!(f, "no startxref found"),
            Error::NoTrailer => write!(f, "no trailer dictionary found"),
            Error::NoRoot => write!(f, "trailer has no /Root"),
            Error::NoSize => write!(f, "trailer has no /Size"),
            Error::XrefStream => write!(
                f,
                "this PDF uses cross-reference streams / object streams; \
                 normalise it through PDFium before appending"
            ),
            Error::MissingObject(n) => write!(f, "object {n} not found by scan"),
            Error::Malformed(s) => write!(f, "malformed PDF: {s}"),
            Error::Io(e) => write!(f, "io: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[inline]
fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | b'\0')
}

#[inline]
fn is_delim(c: u8) -> bool {
    matches!(c, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

/// Skip whitespace and `%` comments.
pub fn skip_ws(d: &[u8], mut i: usize) -> usize {
    while i < d.len() {
        if is_ws(d[i]) {
            i += 1;
        } else if d[i] == b'%' {
            while i < d.len() && d[i] != b'\n' && d[i] != b'\r' {
                i += 1;
            }
        } else {
            break;
        }
    }
    i
}

/// Advance past exactly one PDF object starting at `i`. Returns the index just
/// past it.
pub fn skip_value(d: &[u8], i: usize) -> usize {
    let i = skip_ws(d, i);
    if i >= d.len() {
        return i;
    }
    match d[i] {
        b'<' if d.get(i + 1) == Some(&b'<') => {
            // dictionary, possibly followed by a stream
            let mut j = i + 2;
            let mut depth = 1;
            while j < d.len() && depth > 0 {
                if d[j] == b'<' && d.get(j + 1) == Some(&b'<') {
                    depth += 1;
                    j += 2;
                } else if d[j] == b'>' && d.get(j + 1) == Some(&b'>') {
                    depth -= 1;
                    j += 2;
                } else if d[j] == b'(' {
                    j = skip_value(d, j);
                } else {
                    j += 1;
                }
            }
            j
        }
        b'<' => {
            // hex string
            let mut j = i + 1;
            while j < d.len() && d[j] != b'>' {
                j += 1;
            }
            j + 1
        }
        b'(' => {
            let mut j = i + 1;
            let mut depth = 1;
            while j < d.len() && depth > 0 {
                match d[j] {
                    b'\\' => j += 2,
                    b'(' => {
                        depth += 1;
                        j += 1;
                    }
                    b')' => {
                        depth -= 1;
                        j += 1;
                    }
                    _ => j += 1,
                }
            }
            j
        }
        b'[' => {
            let mut j = i + 1;
            let mut depth = 1;
            while j < d.len() && depth > 0 {
                match d[j] {
                    b'[' => {
                        depth += 1;
                        j += 1;
                    }
                    b']' => {
                        depth -= 1;
                        j += 1;
                    }
                    b'(' | b'<' => j = skip_value(d, j),
                    _ => j += 1,
                }
            }
            j
        }
        b'/' => {
            let mut j = i + 1;
            while j < d.len() && !is_ws(d[j]) && !is_delim(d[j]) {
                j += 1;
            }
            j
        }
        _ => {
            // number, keyword, or an indirect reference "N G R"
            let start = i;
            let mut j = i;
            while j < d.len() && !is_ws(d[j]) && !is_delim(d[j]) {
                j += 1;
            }
            // try to absorb "G R"
            if d[start].is_ascii_digit() {
                let save = j;
                let k = skip_ws(d, j);
                let mut k2 = k;
                while k2 < d.len() && d[k2].is_ascii_digit() {
                    k2 += 1;
                }
                if k2 > k {
                    let k3 = skip_ws(d, k2);
                    if d.get(k3) == Some(&b'R')
                        && d.get(k3 + 1).is_none_or(|c| is_ws(*c) || is_delim(*c))
                    {
                        return k3 + 1;
                    }
                }
                j = save;
            }
            j
        }
    }
}

/// Given `i` pointing at `<<`, return the inclusive-exclusive range of the dict
/// *contents* (between `<<` and the matching `>>`).
pub fn dict_inner(d: &[u8], i: usize) -> Result<(usize, usize)> {
    let i = skip_ws(d, i);
    if d.get(i) != Some(&b'<') || d.get(i + 1) != Some(&b'<') {
        return Err(Error::Malformed("expected <<"));
    }
    let end = skip_value(d, i);
    if end < i + 4 {
        return Err(Error::Malformed("unterminated dict"));
    }
    Ok((i + 2, end - 2))
}

/// Iterate the top-level `(key_range, value_range)` pairs of a dict body.
pub fn dict_entries(d: &[u8], inner: (usize, usize)) -> Vec<((usize, usize), (usize, usize))> {
    let mut out = Vec::new();
    let mut i = inner.0;
    while i < inner.1 {
        i = skip_ws(d, i);
        if i >= inner.1 || d[i] != b'/' {
            break;
        }
        let ks = i;
        let ke = skip_value(d, i);
        let vs = skip_ws(d, ke);
        if vs >= inner.1 {
            break;
        }
        let ve = skip_value(d, vs);
        out.push(((ks, ke), (vs, ve)));
        i = ve;
    }
    out
}

/// Look up one key in a dict body, returning the value byte range.
pub fn dict_get(d: &[u8], inner: (usize, usize), key: &str) -> Option<(usize, usize)> {
    let kb = key.as_bytes();
    dict_entries(d, inner)
        .into_iter()
        .find(|((ks, ke), _)| &d[*ks..*ke] == kb)
        .map(|(_, v)| v)
}

/// Re-emit a dict body with the named keys removed. Used to replace our own
/// private keys instead of duplicating them (duplicate keys make readers pick
/// the *first*, i.e. stale, definition -- a bug we hit and fixed in the proof).
pub fn dict_without(d: &[u8], inner: (usize, usize), drop: &[&str]) -> Vec<u8> {
    let mut out = Vec::new();
    for ((ks, ke), (vs, ve)) in dict_entries(d, inner) {
        let k = &d[ks..ke];
        if drop.iter().any(|x| x.as_bytes() == k) {
            continue;
        }
        out.extend_from_slice(k);
        out.push(b' ');
        out.extend_from_slice(&d[vs..ve]);
        out.push(b'\n');
    }
    out
}

/// Parse `N G R` at `range`, returning `N`.
pub fn as_ref_num(d: &[u8], range: (usize, usize)) -> Option<u32> {
    let s = std::str::from_utf8(&d[range.0..range.1]).ok()?;
    let t = s.trim();
    if !t.ends_with('R') {
        return None;
    }
    t.split_whitespace().next()?.parse().ok()
}

pub fn as_int(d: &[u8], range: (usize, usize)) -> Option<i64> {
    std::str::from_utf8(&d[range.0..range.1]).ok()?.trim().parse().ok()
}

/// Find the body of `num 0 obj ... endobj`, taking the LAST definition in the
/// file (later generations of an incrementally-updated PDF win).
pub fn find_object(d: &[u8], num: u32) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let needle = b"obj";
    let mut i = 0usize;
    while let Some(p) = find(d, needle, i) {
        i = p + 3;
        // walk back: ws, generation digits, ws, object number digits
        let mut j = p;
        while j > 0 && is_ws(d[j - 1]) {
            j -= 1;
        }
        let ge = j;
        while j > 0 && d[j - 1].is_ascii_digit() {
            j -= 1;
        }
        if j == ge {
            continue;
        }
        let mut k = j;
        while k > 0 && is_ws(d[k - 1]) {
            k -= 1;
        }
        if k == j {
            continue;
        }
        let ne = k;
        while k > 0 && d[k - 1].is_ascii_digit() {
            k -= 1;
        }
        if k == ne {
            continue;
        }
        let n: u32 = match std::str::from_utf8(&d[k..ne]).ok().and_then(|s| s.parse().ok()) {
            Some(v) => v,
            None => continue,
        };
        if n != num {
            continue;
        }
        let body_start = skip_ws(d, p + 3);
        let body_end = find(d, b"endobj", body_start).unwrap_or(d.len());
        best = Some((body_start, body_end));
    }
    best
}

pub fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

pub fn rfind(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).rev().find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Byte offset stored in the final `startxref`.
pub fn last_startxref(d: &[u8]) -> Result<usize> {
    let p = rfind(d, b"startxref").ok_or(Error::NoStartxref)?;
    let mut i = skip_ws(d, p + 9);
    let s = i;
    while i < d.len() && d[i].is_ascii_digit() {
        i += 1;
    }
    std::str::from_utf8(&d[s..i])
        .ok()
        .and_then(|x| x.parse::<usize>().ok())
        .ok_or(Error::NoStartxref)
}

/// Position of the `<<` belonging to the last `trailer` keyword.
pub fn last_trailer_dict(d: &[u8]) -> Result<(usize, usize)> {
    let p = rfind(d, b"trailer").ok_or(Error::NoTrailer)?;
    dict_inner(d, skip_ws(d, p + 7))
}
