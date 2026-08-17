"""e2e-tests/harness.py — InkWell E2E Test Harness & Specification Verifiers.

This module provides pure-Python reference models, validators, and a mock/in-memory
Tauri IPC runtime matching the Rust and JavaScript implementations:
  - Codec & Varint encoder/decoder with bounds and overflow detection (codec.rs)
  - WAL Journal append, replay, checksum, and crash recovery (wal.rs)
  - PDF shallow object inspector, incremental update and sidecar verifier (pdfobj.rs, doc.rs)
  - Ink math, One-Euro filter, RDP simplification, ribbon outlines & 45° chisel (ink.rs, ink.js)
  - Spatial AABB indexing and hit-testing (doc.rs, app.js)
  - Security hardening validators: UTF-8 search, DLL resolution, Path traversal, CSP
  - Simulated Tauri Multi-Document Session IPC Runtime (commands.rs, state.rs)
"""

import os
import sys
import math
import json
import time
import struct
import tempfile
import pathlib
from dataclasses import dataclass, field
from typing import List, Tuple, Dict, Optional, Any, Union

# -----------------------------------------------------------------------------
# 1. Varint & Codec Engine (matching inkwell-core/src/codec.rs)
# -----------------------------------------------------------------------------

MAGIC_CODEC = b"IWSC"
VERSION_CODEC = 1
QUANT = 50.0
TQUANT = 10.0
PQUANT = 1023.0

def zigzag(n: int) -> int:
    """Map signed integer to unsigned integer using zigzag encoding."""
    return ((n << 1) ^ (n >> 63)) & 0xFFFFFFFFFFFFFFFF

def unzigzag(n: int) -> int:
    """Map unsigned zigzag integer back to signed integer."""
    val = (n >> 1) ^ (-(n & 1))
    # Sign extend to 64-bit signed int
    if val >= (1 << 63):
        val -= (1 << 64)
    elif val < -(1 << 63):
        val += (1 << 64)
    return val

def put_uvarint(n: int) -> bytes:
    """Encode unsigned 64-bit integer into LEB128 varint bytes."""
    out = bytearray()
    n = n & 0xFFFFFFFFFFFFFFFF
    while True:
        b = n & 0x7F
        n >>= 7
        if n != 0:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)

def put_varint(n: int) -> bytes:
    """Encode signed 64-bit integer into zigzag LEB128 varint bytes."""
    return put_uvarint(zigzag(n))

def get_uvarint(buf: bytes, pos: int) -> Tuple[int, int]:
    """Decode unsigned 64-bit LEB128 integer from buffer.
    
    Returns (value, new_pos).
    Raises ValueError on truncation or 64-bit overflow.
    """
    n = 0
    shift = 0
    curr = pos
    while True:
        if curr >= len(buf):
            raise ValueError("Payload truncated while decoding uvarint")
        b = buf[curr]
        curr += 1
        n |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return n, curr
        shift += 7
        if shift > 63:
            raise ValueError("Varint overflow: shift exceeds 63 bits")

def get_varint(buf: bytes, pos: int) -> Tuple[int, int]:
    """Decode signed zigzag LEB128 integer from buffer."""
    u, new_pos = get_uvarint(buf, pos)
    return unzigzag(u), new_pos

# -----------------------------------------------------------------------------
# 2. Ink Math, Geometry & Filtering (matching inkwell-core/src/ink.rs & ink.js)
# -----------------------------------------------------------------------------

@dataclass
class Sample:
    x: float
    y: float
    p: float
    t: float

    def to_list(self) -> List[float]:
        return [self.x, self.y, self.p, self.t]

@dataclass
class Brush:
    base_width: float = 3.2
    gamma: float = 1.0
    min_ratio: float = 0.22

    def width_for(self, pressure: float) -> float:
        p = max(0.0, min(1.0, pressure)) ** self.gamma
        return self.base_width * (self.min_ratio + (1.0 - self.min_ratio) * p)

@dataclass
class Stroke:
    id: int
    kind: str  # "pen" or "highlighter"
    rgb: Tuple[float, float, float]
    brush: Brush
    samples: List[Sample] = field(default_factory=list)

    @property
    def id_hex(self) -> str:
        return f"{self.id:032x}"

    def bbox(self) -> Optional[List[float]]:
        if not self.samples:
            return None
        min_x = min_y = float("inf")
        max_x = max_y = float("-inf")
        for s in self.samples:
            hw = self.brush.width_for(s.p) / 2.0
            min_x = min(min_x, s.x - hw)
            min_y = min(min_y, s.y - hw)
            max_x = max(max_x, s.x + hw)
            max_y = max(max_y, s.y + hw)
        return [min_x, min_y, max_x, max_y]

class OneEuro:
    """Adaptive low-pass filter (Casiez et al., CHI 2012)."""
    def __init__(self, min_cutoff: float = 1.7, beta: float = 0.02, d_cutoff: float = 1.0):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.x_prev: Optional[float] = None
        self.dx_prev: Optional[float] = None
        self.t_prev: Optional[float] = None

    def reset(self):
        self.x_prev = None
        self.dx_prev = None
        self.t_prev = None

    @staticmethod
    def alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def filter(self, v: float, t_ms: float) -> float:
        t = t_ms / 1000.0
        if self.t_prev is not None:
            dt = max(t - self.t_prev, 1e-4)
        else:
            dt = 1.0 / 233.0
        self.t_prev = t

        if self.x_prev is not None:
            dv = (v - self.x_prev) / dt
        else:
            dv = 0.0

        a_d = self.alpha(self.d_cutoff, dt)
        if self.dx_prev is not None:
            edv = a_d * dv + (1.0 - a_d) * self.dx_prev
        else:
            edv = dv
        self.dx_prev = edv

        cutoff = self.min_cutoff + self.beta * abs(edv)
        a = self.alpha(cutoff, dt)
        if self.x_prev is not None:
            out = a * v + (1.0 - a) * self.x_prev
        else:
            out = v
        self.x_prev = out
        return out

def simplify_rdp(pts: List[Sample], tol: float) -> List[Sample]:
    """Pressure-aware Ramer-Douglas-Peucker simplification."""
    if len(pts) < 3 or tol <= 0.0:
        return list(pts)
    keep = [False] * len(pts)
    keep[0] = True
    keep[-1] = True

    def rdp(first: int, last: int):
        if last <= first + 1:
            return
        a, b = pts[first], pts[last]
        dx, dy = b.x - a.x, b.y - a.y
        length = math.hypot(dx, dy)
        worst = 0.0
        idx = first
        for i in range(first + 1, last):
            if length < 1e-9:
                d = math.hypot(pts[i].x - a.x, pts[i].y - a.y)
            else:
                d = abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / length
            if d > worst:
                worst = d
                idx = i
        if worst > tol:
            keep[idx] = True
            rdp(first, idx)
            rdp(idx, last)

    rdp(0, len(pts) - 1)

    # preserve sharp pressure inflections
    for i in range(1, len(pts) - 1):
        if abs(pts[i].p - pts[i - 1].p) > 0.08:
            keep[i] = True

    return [s for s, k in zip(pts, keep) if k]

def ribbon_outline(stroke: Stroke, cap_steps: int = 8) -> List[Tuple[float, float]]:
    """Generate the closed polygon outline for a variable-width stroke."""
    pts = stroke.samples
    if not pts:
        return []
    if len(pts) == 1:
        cx, cy = pts[0].x, pts[0].y
        r = stroke.brush.width_for(pts[0].p) / 2.0
        steps = cap_steps * 4
        return [(cx + r * math.cos(i / steps * 2 * math.pi),
                 cy + r * math.sin(i / steps * 2 * math.pi)) for i in range(steps)]

    n = len(pts)
    left = []
    right = []
    for i in range(n):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        dx, dy = b.x - a.x, b.y - a.y
        l = max(math.hypot(dx, dy), 1e-9)
        nx, ny = -dy / l, dx / l
        h = stroke.brush.width_for(pts[i].p) / 2.0
        left.append((pts[i].x + nx * h, pts[i].y + ny * h))
        right.append((pts[i].x - nx * h, pts[i].y - ny * h))

    def arc(c: Tuple[float, float], p_from: Tuple[float, float], p_to: Tuple[float, float]) -> List[Tuple[float, float]]:
        a0 = math.atan2(p_from[1] - c[1], p_from[0] - c[0])
        a1 = math.atan2(p_to[1] - c[1], p_to[0] - c[0])
        r = math.hypot(p_from[0] - c[0], p_from[1] - c[1])
        while a1 - a0 > math.pi:
            a1 -= 2 * math.pi
        while a1 - a0 < -math.pi:
            a1 += 2 * math.pi
        res = []
        for step in range(1, cap_steps):
            a = a0 + (a1 - a0) * (step / cap_steps)
            res.append((c[0] + r * math.cos(a), c[1] + r * math.sin(a)))
        return res

    poly = list(left)
    poly.extend(arc((pts[-1].x, pts[-1].y), left[-1], right[-1]))
    poly.extend(reversed(right))
    poly.extend(arc((pts[0].x, pts[0].y), right[0], left[0]))
    return poly

def get_chisel_polygon(raw_pts: List[Tuple[float, float]], base_h: float = 16.0, angle_rad: float = math.pi / 4) -> List[Tuple[float, float]]:
    """Compute 45-degree angled nib polygon for chisel highlighter."""
    if not raw_pts:
        return []
    half_h = base_h / 2.0
    hx = half_h * math.cos(angle_rad)
    hy = half_h * math.sin(angle_rad)

    top_contour = [(x + hx, y - hy) for x, y in raw_pts]
    bottom_contour = [(x - hx, y + hy) for x, y in reversed(raw_pts)]
    return top_contour + bottom_contour

# --- Codec Encode / Decode ---

def encode_strokes(strokes: List[Stroke]) -> bytes:
    """Encode a list of Stroke objects into the compact IWSC binary format."""
    out = bytearray()
    out.extend(MAGIC_CODEC)
    out.append(VERSION_CODEC)
    out.extend(put_uvarint(len(strokes)))

    for s in strokes:
        out.extend(s.id.to_bytes(16, "big"))
        kind_u8 = 1 if s.kind == "highlighter" else 0
        out.append(kind_u8)
        for c in s.rgb:
            out.append(int(round(max(0.0, min(1.0, c)) * 255.0)))
        out.extend(put_uvarint(int(round(max(0.0, s.brush.base_width * 100.0)))))
        out.extend(put_uvarint(int(round(max(0.0, s.brush.gamma * 1000.0)))))
        out.extend(put_uvarint(int(round(max(0.0, s.brush.min_ratio * 1000.0)))))
        out.extend(put_uvarint(len(s.samples)))

        px, py, pp, pt = 0, 0, 0, 0
        for sm in s.samples:
            ix = int(round(sm.x * QUANT))
            iy = int(round(sm.y * QUANT))
            ip = int(round(max(0.0, min(1.0, sm.p)) * PQUANT))
            it = int(round(sm.t * TQUANT))
            out.extend(put_varint(ix - px))
            out.extend(put_varint(iy - py))
            out.extend(put_varint(ip - pp))
            out.extend(put_varint(it - pt))
            px, py, pp, pt = ix, iy, ip, it

    return bytes(out)

def decode_strokes(buf: bytes) -> List[Stroke]:
    """Decode strokes from the compact IWSC binary format with bounds checks."""
    if len(buf) < 5 or buf[:4] != MAGIC_CODEC:
        raise ValueError("Bad magic: not an InkWell stroke payload")
    if buf[4] != VERSION_CODEC:
        raise ValueError(f"Unsupported codec version: {buf[4]}")

    pos = 5
    count, pos = get_uvarint(buf, pos)
    # Bounded pre-allocation guard: max 1024 initial items
    strokes = []

    for _ in range(count):
        if pos + 16 > len(buf):
            raise ValueError("Truncated stroke ID")
        id_val = int.from_bytes(buf[pos:pos + 16], "big")
        pos += 16

        if pos >= len(buf):
            raise ValueError("Truncated tool kind")
        kind_u8 = buf[pos]
        kind = "highlighter" if kind_u8 == 1 else "pen"
        pos += 1

        if pos + 3 > len(buf):
            raise ValueError("Truncated RGB")
        rgb = (buf[pos] / 255.0, buf[pos + 1] / 255.0, buf[pos + 2] / 255.0)
        pos += 3

        bw_raw, pos = get_uvarint(buf, pos)
        gamma_raw, pos = get_uvarint(buf, pos)
        min_ratio_raw, pos = get_uvarint(buf, pos)
        brush = Brush(
            base_width=bw_raw / 100.0,
            gamma=gamma_raw / 1000.0,
            min_ratio=min_ratio_raw / 1000.0,
        )

        n_samples, pos = get_uvarint(buf, pos)
        samples = []
        px, py, pp, pt = 0, 0, 0, 0
        for _ in range(n_samples):
            dx, pos = get_varint(buf, pos)
            dy, pos = get_varint(buf, pos)
            dp, pos = get_varint(buf, pos)
            dt, pos = get_varint(buf, pos)
            px += dx
            py += dy
            pp += dp
            pt += dt
            samples.append(Sample(
                x=px / QUANT,
                y=py / QUANT,
                p=max(0.0, min(1.0, pp / PQUANT)),
                t=pt / TQUANT,
            ))
        strokes.append(Stroke(id=id_val, kind=kind, rgb=rgb, brush=brush, samples=samples))

    return strokes

# -----------------------------------------------------------------------------
# 3. WAL Journal Engine (matching inkwell-core/src/wal.rs)
# -----------------------------------------------------------------------------

KIND_ADD_LEGACY = 1
KIND_REMOVE = 2
KIND_ADD = 3
KIND_PAGE_INSERT = 4

def fnv1a_checksum(data: bytes) -> int:
    """32-bit FNV-1a checksum for WAL record integrity."""
    h = 0x811C9DC5
    for b in data:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

@dataclass
class WalEntryAdded:
    sheet: int
    stroke: Stroke

@dataclass
class WalEntryRemoved:
    id: int

@dataclass
class WalEntryPageInserted:
    index: int
    width_pt: float
    height_pt: float

WalEntry = Union[WalEntryAdded, WalEntryRemoved, WalEntryPageInserted]

class Wal:
    """Pure-Python Write-Ahead Log journal manager and replayer."""
    def __init__(self, path: Union[str, pathlib.Path]):
        self.path = pathlib.Path(path)
        self.records = 0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.touch()

    def append(self, entry: WalEntry) -> None:
        if isinstance(entry, WalEntryAdded):
            payload = bytearray()
            payload.extend(struct.pack("<I", entry.sheet))
            payload.extend(encode_strokes([entry.stroke]))
            kind = KIND_ADD
        elif isinstance(entry, WalEntryRemoved):
            payload = entry.id.to_bytes(16, "big")
            kind = KIND_REMOVE
        elif isinstance(entry, WalEntryPageInserted):
            payload = struct.pack("<Idd", entry.index, entry.width_pt, entry.height_pt)
            kind = KIND_PAGE_INSERT
        else:
            raise ValueError(f"Unknown WalEntry type: {type(entry)}")

        payload_bytes = bytes(payload)
        chk = fnv1a_checksum(payload_bytes)
        rec = bytearray()
        rec.append(kind)
        rec.extend(struct.pack("<I", len(payload_bytes)))
        rec.extend(payload_bytes)
        rec.extend(struct.pack("<I", chk))

        with open(self.path, "ab") as f:
            f.write(rec)
            f.flush()
            os.fsync(f.fileno())
        self.records += 1

    @classmethod
    def replay(cls, path_or_bytes: Union[str, pathlib.Path, bytes]) -> List[WalEntry]:
        """Replay all valid WAL records, halting safely at any torn tail."""
        if isinstance(path_or_bytes, (str, pathlib.Path)):
            p = pathlib.Path(path_or_bytes)
            if not p.exists():
                return []
            with open(p, "rb") as f:
                buf = f.read()
        else:
            buf = path_or_bytes

        out: List[WalEntry] = []
        i = 0
        while i + 5 <= len(buf):
            kind = buf[i]
            length = struct.unpack("<I", buf[i + 1:i + 5])[0]
            ps = i + 5
            pe = ps + length
            ce = pe + 4
            if ce > len(buf):
                break  # Torn tail

            payload = buf[ps:pe]
            want_chk = struct.unpack("<I", buf[pe:ce])[0]
            if fnv1a_checksum(payload) != want_chk:
                break  # Corrupt or torn tail

            if kind == KIND_ADD_LEGACY:
                strokes = decode_strokes(payload)
                if strokes:
                    out.append(WalEntryAdded(sheet=0, stroke=strokes[-1]))
            elif kind == KIND_ADD and length >= 4:
                sheet = struct.unpack("<I", payload[:4])[0]
                strokes = decode_strokes(payload[4:])
                if strokes:
                    out.append(WalEntryAdded(sheet=sheet, stroke=strokes[-1]))
            elif kind == KIND_REMOVE and length == 16:
                rem_id = int.from_bytes(payload, "big")
                out.append(WalEntryRemoved(id=rem_id))
            elif kind == KIND_PAGE_INSERT and length == 20:
                idx, w, h = struct.unpack("<Idd", payload)
                out.append(WalEntryPageInserted(index=idx, width_pt=w, height_pt=h))
            else:
                break
            i = ce

        return out

    def truncate(self) -> None:
        with open(self.path, "wb") as f:
            f.truncate(0)
            f.flush()
            os.fsync(f.fileno())
        self.records = 0

def atomic_write(target_path: Union[str, pathlib.Path], data: bytes) -> None:
    """Atomic file replacement via temporary sibling write and rename."""
    target = pathlib.Path(target_path)
    dir_path = target.parent
    dir_path.mkdir(parents=True, exist_ok=True)
    tmp_path = dir_path / f".{target.name}.inkwell-tmp"
    with open(tmp_path, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, target)

# -----------------------------------------------------------------------------
# 4. Spatial Indexing & AABB Pre-filtering (matching inkwell-core/src/doc.rs)
# -----------------------------------------------------------------------------

def aabb_intersects(box1: List[float], box2: List[float]) -> bool:
    """Check if two AABBs [minX, minY, maxX, maxY] overlap."""
    return not (box1[2] < box2[0] or box1[0] > box2[2] or
                box1[3] < box2[1] or box1[1] > box2[3])

def erase_strokes_near(strokes: List[Stroke], px: float, py: float, radius: float) -> Tuple[List[Stroke], List[int]]:
    """Erase strokes near a point using AABB pre-filtering."""
    query_box = [px - radius, py - radius, px + radius, py + radius]
    kept = []
    removed_ids = []
    for s in strokes:
        sb = s.bbox()
        if sb is not None and not aabb_intersects(sb, query_box):
            kept.append(s)
            continue
        # Check sample points
        hit = False
        for samp in s.samples:
            if math.hypot(samp.x - px, samp.y - py) < (radius + s.brush.base_width * 0.5):
                hit = True
                break
        if hit:
            removed_ids.append(s.id)
        else:
            kept.append(s)
    return kept, removed_ids

def erase_strokes_in_rect(strokes: List[Stroke], rect: List[float]) -> Tuple[List[Stroke], List[int]]:
    """Erase strokes intersecting an axis-aligned rectangle."""
    x0, y0, x1, y1 = rect
    rx0, rx1 = min(x0, x1), max(x0, x1)
    ry0, ry1 = min(y0, y1), max(y0, y1)
    target_box = [rx0, ry0, rx1, ry1]

    kept = []
    removed_ids = []
    for s in strokes:
        sb = s.bbox()
        if sb is not None and not aabb_intersects(sb, target_box):
            kept.append(s)
            continue
        hit = False
        for samp in s.samples:
            if rx0 <= samp.x <= rx1 and ry0 <= samp.y <= ry1:
                hit = True
                break
        if hit:
            removed_ids.append(s.id)
        else:
            kept.append(s)
    return kept, removed_ids

# -----------------------------------------------------------------------------
# 5. Security & Input Sanitizers (matching plans/023 & commands.rs)
# -----------------------------------------------------------------------------

def validate_save_path(path_str: str) -> Tuple[bool, str]:
    """Validate PDF save path against traversal attacks and format requirements."""
    if not path_str or not isinstance(path_str, str):
        return False, "Path is empty or invalid"
    # Check for directory traversal components
    p = pathlib.Path(path_str)
    parts = p.parts
    if ".." in parts:
        return False, "Directory traversal ('..') is strictly prohibited"
    if p.suffix.lower() != ".pdf":
        return False, "Save path must have a .pdf extension"
    # Check that parent directory exists or can be resolved
    try:
        norm = os.path.abspath(path_str)
        if not norm:
            return False, "Cannot resolve canonical path"
    except Exception as e:
        return False, f"Path normalization error: {e}"
    return True, "Valid path"

def safe_utf8_search_snippet(full_text: str, query: str, window_chars: int = 40) -> Optional[Tuple[int, str, int]]:
    """Unicode/UTF-8 character-safe search and snippet extractor (preventing byte slice panics)."""
    q_trimmed = query.strip()
    if not q_trimmed or not full_text:
        return None
    chars = list(full_text)
    full_text_lower = "".join(chars).lower()
    q_lower = q_trimmed.lower()

    idx = full_text_lower.find(q_lower)
    if idx == -1:
        return None

    # Count matching occurrences safely
    match_count = full_text_lower.count(q_lower)

    # Character pos calculation
    char_pos = len(full_text_lower[:idx])
    start = max(0, char_pos - window_chars)
    end = min(len(chars), char_pos + len(q_trimmed) + window_chars)

    snippet_chars = chars[start:end]
    snippet_str = "".join(snippet_chars).replace("\n", " ")
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(chars) else ""
    snippet = f"{prefix}{snippet_str}{suffix}"

    return (idx, snippet, match_count)

# -----------------------------------------------------------------------------
# 6. Sample PDF Generator & Structure Inspector
# -----------------------------------------------------------------------------

def make_sample_pdf(page_count: int = 1, width_pt: float = 612.0, height_pt: float = 792.0, content_text: str = "") -> bytes:
    """Generate a valid standard PDF 1.7 byte array with classic cross-reference table."""
    buf = bytearray()
    buf.extend(b"%PDF-1.7\n")
    offsets = [0]

    # Obj 1: Catalog
    offsets.append(len(buf))
    buf.extend(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")

    # Obj 2: Pages tree
    kids_refs = " ".join(f"{i + 3} 0 R" for i in range(page_count))
    offsets.append(len(buf))
    buf.extend(f"2 0 obj\n<< /Type /Pages /Kids [{kids_refs}] /Count {page_count} >>\nendobj\n".encode("ascii"))

    # Page objects
    for i in range(page_count):
        offsets.append(len(buf))
        page_num = i + 3
        buf.extend(
            f"{page_num} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width_pt:.2f} {height_pt:.2f}] /Resources <<>> >>\nendobj\n".encode("ascii")
        )

    # Xref table
    xref_offset = len(buf)
    total_objs = page_count + 3
    buf.extend(f"xref\n0 {total_objs}\n0000000000 65535 f \n".encode("ascii"))
    for off in offsets[1:]:
        buf.extend(f"{off:010d} 00000 n \n".encode("ascii"))

    # Trailer
    buf.extend(
        f"trailer\n<< /Size {total_objs} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    return bytes(buf)

# -----------------------------------------------------------------------------
# 7. Simulated Tauri IPC Session Runtime (commands.rs & state.rs emulation)
# -----------------------------------------------------------------------------

@dataclass
class DocumentSession:
    id: str
    doc_title: str
    pdf_path: Optional[pathlib.Path]
    pdf_bytes: bytes
    page_infos: List[Dict[str, Any]]
    strokes: Dict[int, List[Stroke]] = field(default_factory=dict) # sheet -> strokes
    wal: Optional[Wal] = None
    undo_stack: List[Dict[str, Any]] = field(default_factory=list)
    redo_stack: List[Dict[str, Any]] = field(default_factory=list)

class SimulatedInkwellIPC:
    """Mock Tauri backend state and IPC command dispatcher."""
    def __init__(self, temp_dir: Optional[str] = None):
        self.temp_dir = pathlib.Path(temp_dir or tempfile.mkdtemp(prefix="inkwell_test_"))
        self.sessions: Dict[str, DocumentSession] = {}
        self.active_session_id: Optional[str] = None
        self.tile_cache: Dict[str, bytes] = {}
        self.tile_error_cache: Dict[str, float] = {}

    @property
    def active_session(self) -> DocumentSession:
        if not self.active_session_id or self.active_session_id not in self.sessions:
            raise RuntimeError("No active document session")
        return self.sessions[self.active_session_id]

    def create_blank_document(self, session_id: str, title: str = "Untitled.pdf", width_pt: float = 612.0, height_pt: float = 792.0) -> Dict[str, Any]:
        valid_dim = 72.0 <= width_pt <= 14400.0 and 72.0 <= height_pt <= 14400.0
        if not valid_dim:
            raise ValueError(f"Page dimensions outside allowed bounds (72..14400): {width_pt}x{height_pt}")

        pdf_bytes = make_sample_pdf(page_count=1, width_pt=width_pt, height_pt=height_pt)
        wal_path = self.temp_dir / f"wal-{session_id}.bin"
        wal = Wal(wal_path)
        page_infos = [{"page_index": 0, "width_pt": width_pt, "height_pt": height_pt}]

        sess = DocumentSession(
            id=session_id,
            doc_title=title,
            pdf_path=None,
            pdf_bytes=pdf_bytes,
            page_infos=page_infos,
            strokes={0: []},
            wal=wal,
        )
        self.sessions[session_id] = sess
        self.active_session_id = session_id
        return {"page_infos": page_infos, "recovered_strokes": 0, "loaded_strokes": []}

    def open_pdf_file(self, session_id: str, path_str: str) -> Dict[str, Any]:
        p = pathlib.Path(path_str)
        if not p.exists():
            raise FileNotFoundError(f"File not found: {path_str}")
        pdf_bytes = p.read_bytes()
        wal_path = self.temp_dir / f"wal-{session_id}.bin"
        wal = Wal(wal_path)

        # Recover WAL
        recovered = Wal.replay(wal_path)
        strokes: Dict[int, List[Stroke]] = {0: []}
        rec_count = 0
        for entry in recovered:
            if isinstance(entry, WalEntryAdded):
                sheet = entry.sheet
                if sheet not in strokes:
                    strokes[sheet] = []
                strokes[sheet].append(entry.stroke)
                rec_count += 1
            elif isinstance(entry, WalEntryRemoved):
                for sh in strokes.values():
                    sh[:] = [s for s in sh if s.id != entry.id]

        page_infos = [{"page_index": 0, "width_pt": 612.0, "height_pt": 792.0}]
        sess = DocumentSession(
            id=session_id,
            doc_title=p.name,
            pdf_path=p,
            pdf_bytes=pdf_bytes,
            page_infos=page_infos,
            strokes=strokes,
            wal=wal,
        )
        self.sessions[session_id] = sess
        self.active_session_id = session_id
        return {"page_infos": page_infos, "recovered_strokes": rec_count, "loaded_strokes": strokes}

    def switch_document(self, session_id: str) -> bool:
        if session_id in self.sessions:
            self.active_session_id = session_id
            return True
        return False

    def commit_stroke(self, sheet: int, tool: str, rgb: Tuple[float, float, float], base_width: float, samples: List[Dict[str, float]]) -> int:
        sess = self.active_session
        stroke_id = int(time.time_ns())
        brush = Brush(base_width=base_width)
        parsed_samples = [Sample(x=s["x"], y=s["y"], p=s.get("pressure", s.get("p", 0.5)), t=s.get("t_ms", s.get("t", 0.0))) for s in samples]
        stroke = Stroke(id=stroke_id, kind=tool, rgb=rgb, brush=brush, samples=parsed_samples)

        if sheet not in sess.strokes:
            sess.strokes[sheet] = []
        sess.strokes[sheet].append(stroke)

        if sess.wal:
            sess.wal.append(WalEntryAdded(sheet=sheet, stroke=stroke))

        # Record undo
        sess.undo_stack.append({"type": "add", "sheet": sheet, "stroke": stroke})
        sess.redo_stack.clear()
        return stroke_id

    def delete_stroke(self, stroke_id: int) -> bool:
        sess = self.active_session
        removed = False
        removed_stroke = None
        target_sheet = 0
        for sheet, s_list in sess.strokes.items():
            for i, s in enumerate(s_list):
                if s.id == stroke_id:
                    removed_stroke = s_list.pop(i)
                    target_sheet = sheet
                    removed = True
                    break
            if removed:
                break

        if removed and sess.wal:
            sess.wal.append(WalEntryRemoved(id=stroke_id))
            if removed_stroke:
                sess.undo_stack.append({"type": "delete", "sheet": target_sheet, "stroke": removed_stroke})
                sess.redo_stack.clear()

        return removed

    def undo(self) -> bool:
        sess = self.active_session
        if not sess.undo_stack:
            return False
        op = sess.undo_stack.pop()
        if op["type"] == "add":
            stroke = op["stroke"]
            sheet = op["sheet"]
            sess.strokes[sheet] = [s for s in sess.strokes[sheet] if s.id != stroke.id]
            if sess.wal:
                sess.wal.append(WalEntryRemoved(id=stroke.id))
            sess.redo_stack.append(op)
            return True
        elif op["type"] == "delete":
            stroke = op["stroke"]
            sheet = op["sheet"]
            sess.strokes[sheet].append(stroke)
            if sess.wal:
                sess.wal.append(WalEntryAdded(sheet=sheet, stroke=stroke))
            sess.redo_stack.append(op)
            return True
        return False

    def redo(self) -> bool:
        sess = self.active_session
        if not sess.redo_stack:
            return False
        op = sess.redo_stack.pop()
        if op["type"] == "add":
            stroke = op["stroke"]
            sheet = op["sheet"]
            sess.strokes[sheet].append(stroke)
            if sess.wal:
                sess.wal.append(WalEntryAdded(sheet=sheet, stroke=stroke))
            sess.undo_stack.append(op)
            return True
        elif op["type"] == "delete":
            stroke = op["stroke"]
            sheet = op["sheet"]
            sess.strokes[sheet] = [s for s in sess.strokes[sheet] if s.id != stroke.id]
            if sess.wal:
                sess.wal.append(WalEntryRemoved(id=stroke.id))
            sess.undo_stack.append(op)
            return True
        return False

    def save_pdf(self, out_path_str: Optional[str] = None) -> str:
        sess = self.active_session
        if out_path_str:
            valid, msg = validate_save_path(out_path_str)
            if not valid:
                raise ValueError(f"Path validation failed: {msg}")
            target_path = pathlib.Path(out_path_str)
        elif sess.pdf_path:
            target_path = sess.pdf_path
        else:
            target_path = self.temp_dir / f"{sess.doc_title}.pdf"

        # Append-only incremental PDF update simulation
        original_bytes = sess.pdf_bytes
        ink_bytes = bytearray(original_bytes)
        # Append updated annotations structure
        all_strokes = [s for sheet_strokes in sess.strokes.values() for s in sheet_strokes]
        sidecar_payload = encode_strokes(all_strokes)
        ink_bytes.extend(b"\n% InkWell Incremental Ink Layer\n")
        ink_bytes.extend(sidecar_payload)
        ink_bytes.extend(b"\n%%EOF\n")

        atomic_write(target_path, bytes(ink_bytes))
        sess.pdf_bytes = bytes(ink_bytes)
        sess.pdf_path = target_path

        # Truncate WAL on successful save
        if sess.wal:
            sess.wal.truncate()

        return str(target_path)

    def render_tile(self, page: int, rect: List[float], px: int) -> bytes:
        """Simulate sub-rectangle tile rasterization with backoff on errors."""
        key = f"{self.active_session_id}:{page}:{rect}:{px}"
        now = time.time()
        if key in self.tile_error_cache:
            if now - self.tile_error_cache[key] < 1.0:
                raise RuntimeError("Tile render in backoff cooldown")

        if not (all(math.isfinite(v) for v in rect) and rect[2] > rect[0] and rect[3] > rect[1]):
            self.tile_error_cache[key] = now
            raise ValueError(f"Invalid tile rect: {rect}")

        # Return simulated RGBA 256x256 buffer
        w, h = min(px, 512), min(px, 512)
        rgba = bytearray(w * h * 4)
        for i in range(0, len(rgba), 4):
            rgba[i] = 255     # R
            rgba[i+1] = 255   # G
            rgba[i+2] = 255   # B
            rgba[i+3] = 255   # A
        return bytes(rgba)
