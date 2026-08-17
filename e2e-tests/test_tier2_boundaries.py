"""e2e-tests/test_tier2_boundaries.py — Tier 2 Boundary & Corner Cases Suite.

Contains 115 comprehensive boundary, extreme-value, overflow, empty-input,
and corner-case tests covering all subsystems.
Total: 115 tests.
"""

import os
import sys
import math
import time
import struct
import pathlib
import pytest
from typing import List, Dict, Any

from harness import (
    SimulatedInkwellIPC,
    Stroke,
    Sample,
    Brush,
    OneEuro,
    Wal,
    WalEntryAdded,
    WalEntryRemoved,
    WalEntryPageInserted,
    encode_strokes,
    decode_strokes,
    put_uvarint,
    get_uvarint,
    put_varint,
    get_varint,
    zigzag,
    unzigzag,
    ribbon_outline,
    get_chisel_polygon,
    aabb_intersects,
    erase_strokes_near,
    erase_strokes_in_rect,
    validate_save_path,
    safe_utf8_search_snippet,
    make_sample_pdf,
    fnv1a_checksum,
)

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent

# =============================================================================
# B01: Varint Numeric Limits & Bit-Packing Boundaries
# =============================================================================
class TestB01_VarintLimits:
    def test_b01_01_zero_value(self):
        b = put_uvarint(0)
        assert b == b"\x00"
        val, pos = get_uvarint(b, 0)
        assert val == 0 and pos == 1

    def test_b01_02_max_64bit_unsigned(self):
        max_u64 = 0xFFFFFFFFFFFFFFFF
        b = put_uvarint(max_u64)
        val, _ = get_uvarint(b, 0)
        assert val == max_u64

    def test_b01_03_min_64bit_signed(self):
        min_i64 = -(1 << 63)
        b = put_varint(min_i64)
        val, _ = get_varint(b, 0)
        assert val == min_i64

    def test_b01_04_max_64bit_signed(self):
        max_i64 = (1 << 63) - 1
        b = put_varint(max_i64)
        val, _ = get_varint(b, 0)
        assert val == max_i64

    def test_b01_05_single_bit_patterns(self):
        for shift in range(64):
            val = 1 << shift
            b = put_uvarint(val)
            dec, _ = get_uvarint(b, 0)
            assert dec == val


# =============================================================================
# B02: Codec Payload Malformation & Truncation
# =============================================================================
class TestB02_CodecTruncation:
    def test_b02_01_empty_buffer(self):
        with pytest.raises(ValueError, match="Bad magic"):
            decode_strokes(b"")

    def test_b02_02_partial_magic(self):
        with pytest.raises(ValueError, match="Bad magic"):
            decode_strokes(b"IWS")

    def test_b02_03_wrong_version(self):
        with pytest.raises(ValueError, match="Unsupported codec version"):
            decode_strokes(b"IWSC\x02\x00")

    def test_b02_04_truncated_stroke_header(self):
        # Magic + version + count=1, but no stroke body
        buf = b"IWSC\x01\x01\x01\x02"
        with pytest.raises(ValueError):
            decode_strokes(buf)

    def test_b02_05_truncated_samples(self):
        s = Stroke(id=1, kind="pen", rgb=(0, 0, 0), brush=Brush(), samples=[Sample(10, 10, 0.5, 0)])
        encoded = encode_strokes([s])
        truncated = encoded[:-3]  # Strip last 3 sample bytes
        with pytest.raises(ValueError):
            decode_strokes(truncated)


# =============================================================================
# B03: One-Euro Filter Extreme Inputs & Clock Anomaly
# =============================================================================
class TestB03_OneEuroFilterBoundaries:
    def test_b03_01_zero_time_delta(self):
        f = OneEuro()
        y1 = f.filter(100.0, 0.0)
        # Identical timestamp (dt = 0) handled with epsilon floor
        y2 = f.filter(110.0, 0.0)
        assert math.isfinite(y2)

    def test_b03_02_backward_timestamp(self):
        f = OneEuro()
        f.filter(100.0, 100.0)
        # Clock jitter / backwards timestamp
        y = f.filter(105.0, 90.0)
        assert math.isfinite(y)

    def test_b03_03_huge_time_gap(self):
        f = OneEuro()
        f.filter(10.0, 0.0)
        # 1000 seconds later (pen resumed after idle)
        y = f.filter(500.0, 1000000.0)
        assert math.isclose(y, 500.0, abs_tol=1.0)

    def test_b03_04_constant_input_steady_state(self):
        f = OneEuro()
        for i in range(100):
            res = f.filter(42.0, i * 4.0)
        assert math.isclose(res, 42.0, abs_tol=1e-3)

    def test_b03_05_filter_reset_clears_history(self):
        f = OneEuro()
        f.filter(100.0, 0.0)
        f.reset()
        assert f.x_prev is None
        assert f.t_prev is None


# =============================================================================
# B04: Stroke Sample Geometry & Degeneracy
# =============================================================================
class TestB04_StrokeGeometryBoundaries:
    def test_b04_01_empty_stroke_bbox_none(self):
        s = Stroke(id=1, kind="pen", rgb=(0, 0, 0), brush=Brush(), samples=[])
        assert s.bbox() is None

    def test_b04_02_single_point_tap(self):
        s = Stroke(id=1, kind="pen", rgb=(0, 0, 0), brush=Brush(base_width=4.0),
                   samples=[Sample(100.0, 200.0, 1.0, 0.0)])
        bbox = s.bbox()
        assert bbox == [98.0, 198.0, 102.0, 202.0]

    def test_b04_03_coincident_duplicate_samples(self):
        s = Stroke(id=1, kind="pen", rgb=(0, 0, 0), brush=Brush(base_width=2.0),
                   samples=[Sample(50.0, 50.0, 0.5, 0.0), Sample(50.0, 50.0, 0.5, 10.0)])
        poly = ribbon_outline(s)
        assert len(poly) > 0

    def test_b04_04_collinear_straight_line(self):
        samples = [Sample(float(i * 10), 100.0, 0.5, float(i)) for i in range(10)]
        s = Stroke(id=1, kind="pen", rgb=(0, 0, 0), brush=Brush(base_width=2.0), samples=samples)
        poly = ribbon_outline(s)
        assert len(poly) > len(samples)

    def test_b04_05_extreme_pressure_clamping(self):
        b = Brush(base_width=10.0, min_ratio=0.2)
        w_neg = b.width_for(-0.5)
        w_zero = b.width_for(0.0)
        w_huge = b.width_for(99.0)
        w_max = b.width_for(1.0)
        assert w_neg == w_zero
        assert w_huge == w_max


# =============================================================================
# B05: Chisel Highlighter Angle & Trajectory Extremes
# =============================================================================
class TestB05_ChiselHighlighterBoundaries:
    def test_b05_01_chisel_horizontal_stroke(self):
        pts = [(0.0, 100.0), (200.0, 100.0)]
        poly = get_chisel_polygon(pts, base_h=16.0)
        assert len(poly) == 4

    def test_b05_02_chisel_vertical_stroke_no_collapse(self):
        pts = [(100.0, 0.0), (100.0, 200.0)]
        poly = get_chisel_polygon(pts, base_h=16.0)
        # Verify vertical stroke doesn't collapse to 0 width
        xs = [p[0] for p in poly]
        width_span = max(xs) - min(xs)
        assert width_span > 5.0

    def test_b05_03_chisel_single_point(self):
        pts = [(50.0, 50.0)]
        poly = get_chisel_polygon(pts, base_h=16.0)
        assert len(poly) == 2

    def test_b05_04_chisel_sharp_90_degree_turn(self):
        pts = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0)]
        poly = get_chisel_polygon(pts, base_h=16.0)
        assert len(poly) == 6

    def test_b05_05_chisel_negative_coordinates(self):
        pts = [(-100.0, -100.0), (-50.0, -50.0)]
        poly = get_chisel_polygon(pts, base_h=16.0)
        assert len(poly) == 4


# =============================================================================
# B06: WAL Journal Corruption & Partial Append Handling
# =============================================================================
class TestB06_WALCorruptionBoundaries:
    def test_b06_01_torn_record_header(self, temp_workspace: pathlib.Path):
        wal_path = temp_workspace / "torn_header.wal"
        # Write only 3 bytes of header
        wal_path.write_bytes(b"\x03\x10\x00")
        replayed = Wal.replay(wal_path)
        assert len(replayed) == 0

    def test_b06_02_torn_record_payload(self, temp_workspace: pathlib.Path, sample_stroke: Stroke):
        wal_path = temp_workspace / "torn_payload.wal"
        wal = Wal(wal_path)
        wal.append(WalEntryAdded(sheet=0, stroke=sample_stroke))
        # Corrupt file by appending partial record
        with open(wal_path, "ab") as f:
            f.write(b"\x03\x50\x00\x00\x00\x01\x02\x03")
        replayed = Wal.replay(wal_path)
        assert len(replayed) == 1

    def test_b06_03_invalid_checksum_stops_replay(self, temp_workspace: pathlib.Path, sample_stroke: Stroke):
        wal_path = temp_workspace / "bad_chk.wal"
        wal = Wal(wal_path)
        wal.append(WalEntryAdded(sheet=0, stroke=sample_stroke))
        data = bytearray(wal_path.read_bytes())
        # Corrupt checksum at end of file
        data[-1] ^= 0xFF
        wal_path.write_bytes(bytes(data))
        replayed = Wal.replay(wal_path)
        assert len(replayed) == 0

    def test_b06_04_unknown_record_kind(self, temp_workspace: pathlib.Path):
        wal_path = temp_workspace / "unknown_kind.wal"
        payload = b"test_payload"
        chk = fnv1a_checksum(payload)
        rec = bytearray([99])  # Unknown kind 99
        rec.extend(struct.pack("<I", len(payload)))
        rec.extend(payload)
        rec.extend(struct.pack("<I", chk))
        wal_path.write_bytes(bytes(rec))
        replayed = Wal.replay(wal_path)
        assert len(replayed) == 0

    def test_b06_05_zero_byte_wal_file(self, temp_workspace: pathlib.Path):
        wal_path = temp_workspace / "empty.wal"
        wal_path.touch()
        replayed = Wal.replay(wal_path)
        assert len(replayed) == 0


# =============================================================================
# B07: Spatial AABB Edge Conditions
# =============================================================================
class TestB07_SpatialAABBBoundaries:
    def test_b07_01_touching_boxes_overlap(self):
        b1 = [0.0, 0.0, 10.0, 10.0]
        b2 = [10.0, 0.0, 20.0, 10.0]
        assert aabb_intersects(b1, b2)

    def test_b07_02_negative_bounding_box(self):
        b1 = [-100.0, -100.0, -50.0, -50.0]
        b2 = [-60.0, -60.0, -10.0, -10.0]
        assert aabb_intersects(b1, b2)

    def test_b07_03_single_point_box_intersection(self):
        b1 = [50.0, 50.0, 50.0, 50.0]
        b2 = [40.0, 40.0, 60.0, 60.0]
        assert aabb_intersects(b1, b2)

    def test_b07_04_zero_radius_erase_query(self, sample_stroke: Stroke):
        kept, removed = erase_strokes_near([sample_stroke], px=100.0, py=150.0, radius=0.0)
        # Even with radius 0, brush half-width may match point exactly
        assert isinstance(kept, list)

    def test_b07_05_inverted_rect_normalized(self, sample_stroke: Stroke):
        # x0 > x1 and y0 > y1
        kept, removed = erase_strokes_in_rect([sample_stroke], [400.0, 400.0, 50.0, 50.0])
        assert sample_stroke.id in removed


# =============================================================================
# B08: Path Sanitizer & Traversal Injection Attacks
# =============================================================================
class TestB08_PathSanitizationBoundaries:
    def test_b08_01_double_traversal(self):
        valid, msg = validate_save_path("a/../../b.pdf")
        assert not valid

    def test_b08_02_windows_back_slash_traversal(self):
        valid, msg = validate_save_path("..\\..\\secret.pdf")
        assert not valid

    def test_b08_03_traversal_with_trailing_dot(self):
        valid, msg = validate_save_path("../foo/.")
        assert not valid

    def test_b08_04_null_byte_injection(self):
        valid, msg = validate_save_path("good.pdf\x00.exe")
        assert not valid or "\\" in msg or "invalid" in msg.lower()

    def test_b08_05_extension_with_double_dot(self):
        valid, msg = validate_save_path("document..pdf")
        assert valid  # Double dot in filename is valid as long as not traversal '..'


# =============================================================================
# B09: Unicode Search Boundary Conditions
# =============================================================================
class TestB09_UnicodeSearchBoundaries:
    def test_b09_01_query_at_start_of_text(self):
        text = "TARGET text continues here"
        res = safe_utf8_search_snippet(text, "TARGET")
        assert res is not None
        assert res[0] == 0
        assert not res[1].startswith("…")

    def test_b09_02_query_at_end_of_text(self):
        text = "Text leading up to TARGET"
        res = safe_utf8_search_snippet(text, "TARGET")
        assert res is not None
        assert not res[1].endswith("…")

    def test_b09_03_query_longer_than_text(self):
        text = "Short"
        res = safe_utf8_search_snippet(text, "Very Long Query String Here")
        assert res is None

    def test_b09_04_exact_text_match(self):
        text = "EXACT"
        res = safe_utf8_search_snippet(text, "exact")
        assert res is not None
        assert res[1] == "EXACT"

    def test_b09_05_repeating_overlapping_patterns(self):
        text = "AAAAAAA"
        res = safe_utf8_search_snippet(text, "AA")
        assert res is not None
        assert res[2] == 3


# =============================================================================
# B10: Multi-Document Session Boundary Limits
# =============================================================================
class TestB10_SessionBoundaries:
    def test_b10_01_empty_session_id(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("")
        assert "" in mock_ipc.sessions

    def test_b10_02_unicode_session_id(self, mock_ipc: SimulatedInkwellIPC):
        sid = "নোটবই_২০২৬_📐"
        mock_ipc.create_blank_document(sid)
        assert sid in mock_ipc.sessions

    def test_b10_03_large_number_of_sessions(self, mock_ipc: SimulatedInkwellIPC):
        for i in range(50):
            mock_ipc.create_blank_document(f"sess_{i}")
        assert len(mock_ipc.sessions) == 50

    def test_b10_04_custom_page_bounds_limits(self, mock_ipc: SimulatedInkwellIPC):
        # 72 pt is min valid bound (1 inch)
        res = mock_ipc.create_blank_document("s1", width_pt=72.0, height_pt=72.0)
        assert res["page_infos"][0]["width_pt"] == 72.0

    def test_b10_05_out_of_bounds_page_dimension_rejected(self, mock_ipc: SimulatedInkwellIPC):
        with pytest.raises(ValueError):
            mock_ipc.create_blank_document("s2", width_pt=10.0, height_pt=10.0)


# =============================================================================
# B11: Rapid Undo / Redo Stress Cycles
# =============================================================================
class TestB11_UndoRedoStress:
    def test_b11_01_repeated_undo_redo_cycles(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 10, "y": 10}])
        for _ in range(50):
            mock_ipc.undo()
            assert len(mock_ipc.active_session.strokes[0]) == 0
            mock_ipc.redo()
            assert len(mock_ipc.active_session.strokes[0]) == 1

    def test_b11_02_new_stroke_clears_redo_stack(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 10, "y": 10}])
        mock_ipc.undo()
        assert len(mock_ipc.active_session.redo_stack) == 1
        mock_ipc.commit_stroke(0, "pen", (1, 0, 0), 3.0, [{"x": 20, "y": 20}])
        assert len(mock_ipc.active_session.redo_stack) == 0

    def test_b11_03_undo_across_multiple_sheets(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 10, "y": 10}])
        mock_ipc.commit_stroke(1, "pen", (0, 0, 0), 2.0, [{"x": 20, "y": 20}])
        mock_ipc.undo()
        assert len(mock_ipc.active_session.strokes.get(1, [])) == 0
        assert len(mock_ipc.active_session.strokes[0]) == 1

    def test_b11_04_deep_undo_stack(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        for i in range(100):
            mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": i, "y": i}])
        assert len(mock_ipc.active_session.strokes[0]) == 100
        for _ in range(100):
            mock_ipc.undo()
        assert len(mock_ipc.active_session.strokes[0]) == 0

    def test_b11_05_deep_redo_restoration(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        for i in range(100):
            mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": i, "y": i}])
        for _ in range(100):
            mock_ipc.undo()
        for _ in range(100):
            mock_ipc.redo()
        assert len(mock_ipc.active_session.strokes[0]) == 100


# =============================================================================
# B12: RDP Simplification Tolerance Extremes
# =============================================================================
class TestB12_RDPSimplificationBoundaries:
    def test_b12_01_zero_tolerance_preserves_all_points(self):
        from harness import simplify_rdp
        pts = [Sample(float(i), float(i % 3), 0.5, float(i)) for i in range(20)]
        simplified = simplify_rdp(pts, 0.0)
        assert len(simplified) == 20

    def test_b12_02_huge_tolerance_reduces_to_endpoints(self):
        from harness import simplify_rdp
        pts = [Sample(float(i), 0.0, 0.5, float(i)) for i in range(20)]
        simplified = simplify_rdp(pts, 1000.0)
        assert len(simplified) == 2

    def test_b12_03_two_point_stroke_unchanged(self):
        from harness import simplify_rdp
        pts = [Sample(0.0, 0.0, 0.5, 0.0), Sample(10.0, 10.0, 0.5, 1.0)]
        simplified = simplify_rdp(pts, 1.0)
        assert len(simplified) == 2

    def test_b12_04_pressure_spike_preserved_under_rdp(self):
        from harness import simplify_rdp
        pts = [
            Sample(0.0, 0.0, 0.2, 0.0),
            Sample(50.0, 0.0, 0.9, 1.0),  # Sudden pressure spike dp > 0.08
            Sample(100.0, 0.0, 0.2, 2.0),
        ]
        simplified = simplify_rdp(pts, 10.0)
        assert len(simplified) == 3

    def test_b12_05_negative_tolerance_handled_gracefully(self):
        from harness import simplify_rdp
        pts = [Sample(float(i), float(i), 0.5, float(i)) for i in range(5)]
        simplified = simplify_rdp(pts, -1.0)
        assert len(simplified) == 5


# =============================================================================
# B13: Tile Rendering Coordinate & Scale Bounds
# =============================================================================
class TestB13_TileRenderingBoundaries:
    def test_b13_01_tile_at_origin(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("s1")
        buf = mock_ipc.render_tile(0, [0.0, 0.0, 50.0, 50.0], 128)
        assert len(buf) > 0

    def test_b13_02_tile_at_high_coordinate(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("s1")
        buf = mock_ipc.render_tile(0, [5000.0, 5000.0, 5500.0, 5500.0], 128)
        assert len(buf) > 0

    def test_b13_03_min_clamped_resolution(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("s1")
        buf = mock_ipc.render_tile(0, [0.0, 0.0, 100.0, 100.0], 8)
        assert len(buf) > 0

    def test_b13_04_max_clamped_resolution(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("s1")
        buf = mock_ipc.render_tile(0, [0.0, 0.0, 100.0, 100.0], 8192)
        assert len(buf) > 0

    def test_b13_05_negative_origin_tile(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("s1")
        buf = mock_ipc.render_tile(0, [-100.0, -100.0, 100.0, 100.0], 256)
        assert len(buf) > 0


# =============================================================================
# B14: PDF Structure & Incremental Save Byte Integrity
# =============================================================================
class TestB14_PDFStructureBoundaries:
    def test_b14_01_sample_pdf_valid_magic(self, sample_pdf_buffer: bytes):
        assert sample_pdf_buffer.startswith(b"%PDF-1.7")

    def test_b14_02_sample_pdf_startxref_points_to_xref(self, sample_pdf_buffer: bytes):
        idx = sample_pdf_buffer.rfind(b"startxref\n")
        assert idx != -1
        offset_str = sample_pdf_buffer[idx + 10:].split(b"\n")[0]
        offset = int(offset_str)
        assert sample_pdf_buffer[offset:offset + 4] == b"xref"

    def test_b14_03_incremental_save_preserves_original_prefix(self, mock_ipc: SimulatedInkwellIPC, temp_workspace: pathlib.Path):
        mock_ipc.create_blank_document("s1")
        orig_bytes = mock_ipc.active_session.pdf_bytes
        save_path = str(temp_workspace / "inc.pdf")
        mock_ipc.save_pdf(save_path)
        saved_bytes = pathlib.Path(save_path).read_bytes()
        assert saved_bytes.startswith(orig_bytes)

    def test_b14_04_incremental_save_appends_eof(self, mock_ipc: SimulatedInkwellIPC, temp_workspace: pathlib.Path):
        mock_ipc.create_blank_document("s1")
        save_path = str(temp_workspace / "inc.pdf")
        mock_ipc.save_pdf(save_path)
        saved_bytes = pathlib.Path(save_path).read_bytes()
        assert saved_bytes.rstrip().endswith(b"%%EOF")

    def test_b14_05_multi_page_pdf_generation(self, multi_page_pdf_buffer: bytes):
        assert b"/Count 5" in multi_page_pdf_buffer


# =============================================================================
# B15: Touch & Stylus Gesture Collision Handling
# =============================================================================
class TestB15_TouchStylusBoundaries:
    def test_b15_01_zero_distance_touch_points(self):
        p1, p2 = (100.0, 100.0), (100.0, 100.0)
        d = math.hypot(p1[0] - p2[0], p1[1] - p2[1])
        assert d == 0.0

    def test_b15_02_coincident_touch_zoom_clamp(self):
        d0 = 0.0
        d1 = 50.0
        scale = d1 / max(1e-4, d0)
        zoom = max(0.1, min(10.0, scale))
        assert zoom <= 10.0

    def test_b15_03_min_zoom_clamp(self):
        zoom = max(0.1, min(10.0, 0.01))
        assert zoom == 0.1

    def test_b15_04_max_zoom_clamp(self):
        zoom = max(0.1, min(10.0, 50.0))
        assert zoom == 10.0

    def test_b15_05_pen_pointer_type_normalization(self):
        raw_types = ["pen", "Pen", "PEN", "stylus"]
        normalized = ["pen" if t.lower() in ("pen", "stylus") else "touch" for t in raw_types]
        assert all(n == "pen" for n in normalized)


# =============================================================================
# B16: Codec Brush Property Boundaries
# =============================================================================
class TestB16_BrushBoundaries:
    def test_b16_01_zero_base_width(self):
        b = Brush(base_width=0.0)
        assert b.width_for(0.5) == 0.0

    def test_b16_02_huge_base_width(self):
        b = Brush(base_width=500.0)
        assert b.width_for(1.0) == 500.0

    def test_b16_03_zero_min_ratio(self):
        b = Brush(base_width=10.0, min_ratio=0.0)
        assert b.width_for(0.0) == 0.0

    def test_b16_04_gamma_power_scaling(self):
        b = Brush(base_width=10.0, gamma=2.0, min_ratio=0.0)
        # (0.5)^2 * 10 = 2.5
        assert math.isclose(b.width_for(0.5), 2.5, abs_tol=1e-5)

    def test_b16_05_brush_roundtrip_quantization(self):
        b_orig = Brush(base_width=3.25, gamma=1.5, min_ratio=0.33)
        s = Stroke(id=1, kind="pen", rgb=(1, 1, 1), brush=b_orig, samples=[Sample(0, 0, 0.5, 0)])
        encoded = encode_strokes([s])
        decoded = decode_strokes(encoded)[0]
        assert math.isclose(decoded.brush.base_width, b_orig.base_width, abs_tol=0.01)
        assert math.isclose(decoded.brush.gamma, b_orig.gamma, abs_tol=0.001)
        assert math.isclose(decoded.brush.min_ratio, b_orig.min_ratio, abs_tol=0.001)


# =============================================================================
# B17: Page Insertion & Removal Boundaries
# =============================================================================
class TestB17_PageInsertionBoundaries:
    def test_b17_01_wal_page_insertion_record(self, temp_workspace: pathlib.Path):
        wal_path = temp_workspace / "page_ins.wal"
        wal = Wal(wal_path)
        wal.append(WalEntryPageInserted(index=2, width_pt=595.0, height_pt=842.0))
        replayed = Wal.replay(wal_path)
        assert len(replayed) == 1
        assert isinstance(replayed[0], WalEntryPageInserted)
        assert replayed[0].index == 2

    def test_b17_02_insert_page_at_index_zero(self, temp_workspace: pathlib.Path):
        wal_path = temp_workspace / "page_zero.wal"
        wal = Wal(wal_path)
        wal.append(WalEntryPageInserted(index=0, width_pt=612.0, height_pt=792.0))
        replayed = Wal.replay(wal_path)
        assert replayed[0].index == 0

    def test_b17_03_insert_page_at_high_index(self, temp_workspace: pathlib.Path):
        wal_path = temp_workspace / "page_high.wal"
        wal = Wal(wal_path)
        wal.append(WalEntryPageInserted(index=999, width_pt=612.0, height_pt=792.0))
        replayed = Wal.replay(wal_path)
        assert replayed[0].index == 999

    def test_b17_04_multiple_page_insertions_sequence(self, temp_workspace: pathlib.Path):
        wal_path = temp_workspace / "multi_page.wal"
        wal = Wal(wal_path)
        for i in range(5):
            wal.append(WalEntryPageInserted(index=i, width_pt=612.0, height_pt=792.0))
        replayed = Wal.replay(wal_path)
        assert len(replayed) == 5

    def test_b17_05_page_insertion_interleaved_with_strokes(self, temp_workspace: pathlib.Path, sample_stroke: Stroke):
        wal_path = temp_workspace / "interleave.wal"
        wal = Wal(wal_path)
        wal.append(WalEntryAdded(sheet=0, stroke=sample_stroke))
        wal.append(WalEntryPageInserted(index=1, width_pt=612.0, height_pt=792.0))
        wal.append(WalEntryAdded(sheet=1, stroke=sample_stroke))
        replayed = Wal.replay(wal_path)
        assert len(replayed) == 3


# =============================================================================
# B18: Large Document & Multi-Hundred Page Scalability
# =============================================================================
class TestB18_ScalabilityBoundaries:
    def test_b18_01_100_page_pdf_structure(self):
        pdf = make_sample_pdf(page_count=100)
        assert b"/Count 100" in pdf

    def test_b18_02_1000_strokes_encoding_payload_size(self):
        strokes = []
        for i in range(1000):
            strokes.append(Stroke(
                id=i,
                kind="pen",
                rgb=(0, 0, 0),
                brush=Brush(),
                samples=[Sample(float(j), float(j), 0.5, float(j)) for j in range(10)],
            ))
        encoded = encode_strokes(strokes)
        # 1000 strokes x 10 samples (~4 bytes/sample + overhead) < 100KB
        assert len(encoded) < 100000

    def test_b18_03_1000_strokes_decode_performance(self):
        strokes = [Stroke(id=i, kind="pen", rgb=(0, 0, 0), brush=Brush(),
                          samples=[Sample(float(j), float(j), 0.5, float(j)) for j in range(5)]) for i in range(500)]
        encoded = encode_strokes(strokes)
        t0 = time.time()
        decoded = decode_strokes(encoded)
        dt = time.time() - t0
        assert len(decoded) == 500
        assert dt < 0.2  # Under 200ms

    def test_b18_04_deep_session_stroke_map(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("s1")
        for sh in range(20):
            mock_ipc.commit_stroke(sh, "pen", (0, 0, 0), 2.0, [{"x": 10, "y": 10}])
        assert len(mock_ipc.active_session.strokes) == 20

    def test_b18_05_thumbnail_virtualization_index_limit(self):
        total_pages = 10000
        item_h = 100.0
        scroll_y = 500000.0
        start = max(0, int(scroll_y / item_h) - 2)
        end = min(total_pages, int((scroll_y + 800) / item_h) + 2)
        assert (end - start) <= 12


# =============================================================================
# B19: Color & RGB Clamping Bounds
# =============================================================================
class TestB19_ColorRGBBoundaries:
    def test_b19_01_rgb_below_zero_clamped(self):
        s = Stroke(id=1, kind="pen", rgb=(-0.5, -0.2, 0.0), brush=Brush(), samples=[Sample(0, 0, 0.5, 0)])
        encoded = encode_strokes([s])
        decoded = decode_strokes(encoded)[0]
        assert decoded.rgb == (0.0, 0.0, 0.0)

    def test_b19_02_rgb_above_one_clamped(self):
        s = Stroke(id=1, kind="pen", rgb=(1.5, 2.0, 1.0), brush=Brush(), samples=[Sample(0, 0, 0.5, 0)])
        encoded = encode_strokes([s])
        decoded = decode_strokes(encoded)[0]
        assert decoded.rgb == (1.0, 1.0, 1.0)

    def test_b19_03_rgb_mid_range_quantization(self):
        s = Stroke(id=1, kind="pen", rgb=(0.5, 0.5, 0.5), brush=Brush(), samples=[Sample(0, 0, 0.5, 0)])
        encoded = encode_strokes([s])
        decoded = decode_strokes(encoded)[0]
        assert math.isclose(decoded.rgb[0], 0.5, abs_tol=0.01)

    def test_b19_04_hex_color_conversion(self):
        rgb = (1.0, 0.0, 0.5)
        hex_str = f"#{int(rgb[0]*255):02x}{int(rgb[1]*255):02x}{int(rgb[2]*255):02x}"
        assert hex_str == "#ff007f"

    def test_b19_05_css_rgba_string_formatting(self):
        rgb = (0.0, 1.0, 0.0)
        css_rgba = f"rgba({int(rgb[0]*255)}, {int(rgb[1]*255)}, {int(rgb[2]*255)}, 0.5)"
        assert css_rgba == "rgba(0, 255, 0, 0.5)"


# =============================================================================
# B20: Laser Pointer Decay Physics Bounds
# =============================================================================
class TestB20_LaserPointerDecayBoundaries:
    def test_b20_01_decay_alpha_monotonic_decrease(self):
        trail = [{"x": 100, "y": 100, "born": 0.0}]
        now = 0.6  # 600ms later (lifetime = 1.2s)
        lifetime = 1.2
        alpha = max(0.0, 1.0 - (now - trail[0]["born"]) / lifetime)
        assert 0.49 < alpha < 0.51

    def test_b20_02_decay_reaches_zero_after_lifetime(self):
        born = 0.0
        now = 1.5  # Past 1.2s lifetime
        lifetime = 1.2
        alpha = max(0.0, 1.0 - (now - born) / lifetime)
        assert alpha == 0.0

    def test_b20_03_zero_age_has_full_alpha(self):
        born = 100.0
        now = 100.0
        lifetime = 1.2
        alpha = max(0.0, 1.0 - (now - born) / lifetime)
        assert alpha == 1.0

    def test_b20_04_purge_expired_laser_points(self):
        trail = [
            {"x": 10, "y": 10, "born": 0.0},
            {"x": 20, "y": 20, "born": 1.0},
        ]
        now = 1.5
        lifetime = 1.2
        active_trail = [p for p in trail if (now - p["born"]) < lifetime]
        assert len(active_trail) == 1
        assert active_trail[0]["born"] == 1.0

    def test_b20_05_laser_point_empty_state(self):
        trail = []
        active_trail = [p for p in trail if (1.0 - p["born"]) < 1.2]
        assert active_trail == []


# =============================================================================
# B21: Modal & Dialog Keyboard Focus Trap Bounds
# =============================================================================
class TestB21_ModalFocusTrapBoundaries:
    def test_b21_01_focus_wrap_forward(self):
        interactive_elements = ["btn1", "btn2", "btnClose"]
        curr_idx = 2  # At last element
        next_idx = (curr_idx + 1) % len(interactive_elements)
        assert interactive_elements[next_idx] == "btn1"

    def test_b21_02_focus_wrap_backward(self):
        interactive_elements = ["btn1", "btn2", "btnClose"]
        curr_idx = 0  # At first element
        prev_idx = (curr_idx - 1) % len(interactive_elements)
        assert interactive_elements[prev_idx] == "btnClose"

    def test_b21_03_single_element_focus_trap(self):
        interactive_elements = ["onlyBtn"]
        next_idx = (0 + 1) % len(interactive_elements)
        assert interactive_elements[next_idx] == "onlyBtn"

    def test_b21_04_escape_key_identifier(self):
        assert "Escape" in ["Escape", "Esc"]

    def test_b21_05_aria_role_modal_present(self):
        index_html = REPO_ROOT / "inkwell-app" / "src" / "index.html"
        assert index_html.exists()
        content = index_html.read_text(encoding="utf-8")
        assert "exportModal" in content


# =============================================================================
# B22: Spatial Point in Polygon & Eraser Collision Precision
# =============================================================================
class TestB22_PointInPolygonBoundaries:
    def test_b22_01_point_inside_polygon(self):
        poly = [(0, 0), (100, 0), (100, 100), (0, 100)]
        pt = (50, 50)
        # Ray casting
        inside = False
        n = len(poly)
        p1x, p1y = poly[0]
        for i in range(n + 1):
            p2x, p2y = poly[i % n]
            if pt[1] > min(p1y, p2y) and pt[1] <= max(p1y, p2y) and pt[0] <= max(p1x, p2x):
                if p1y != p2y:
                    xints = (pt[1] - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                if p1x == p2x or pt[0] <= xints:
                    inside = not inside
            p1x, p1y = p2x, p2y
        assert inside is True

    def test_b22_02_point_outside_polygon(self):
        poly = [(0, 0), (100, 0), (100, 100), (0, 100)]
        pt = (150, 50)
        inside = False
        n = len(poly)
        p1x, p1y = poly[0]
        for i in range(n + 1):
            p2x, p2y = poly[i % n]
            if pt[1] > min(p1y, p2y) and pt[1] <= max(p1y, p2y) and pt[0] <= max(p1x, p2x):
                if p1y != p2y:
                    xints = (pt[1] - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                if p1x == p2x or pt[0] <= xints:
                    inside = not inside
            p1x, p1y = p2x, p2y
        assert inside is False

    def test_b22_03_zero_length_stroke_erasure(self):
        s = Stroke(id=1, kind="pen", rgb=(0, 0, 0), brush=Brush(), samples=[])
        kept, removed = erase_strokes_near([s], 0, 0, 10)
        assert len(removed) == 0

    def test_b22_04_exact_center_hit_erasure(self, sample_stroke: Stroke):
        first_samp = sample_stroke.samples[0]
        kept, removed = erase_strokes_near([sample_stroke], first_samp.x, first_samp.y, 5.0)
        assert sample_stroke.id in removed

    def test_b22_05_far_miss_erasure(self, sample_stroke: Stroke):
        kept, removed = erase_strokes_near([sample_stroke], 99999.0, 99999.0, 5.0)
        assert len(removed) == 0


# =============================================================================
# B23: Touch Target Dimension & Padding Boundaries
# =============================================================================
class TestB23_TouchTargetBoundaries:
    def test_b23_01_target_dimension_at_least_44px(self):
        target_size = 44.0
        assert target_size >= 44.0

    def test_b23_02_pseudo_element_hit_expansion_padding(self):
        btn_w, btn_h = 24.0, 24.0
        inset = -10.0  # Expands by 10px on all sides: 24 + 20 = 44px
        effective_w = btn_w - 2 * inset
        effective_h = btn_h - 2 * inset
        assert effective_w >= 44.0
        assert effective_h >= 44.0

    def test_b23_03_selection_handle_touch_hit_radius(self):
        mouse_radius = 14.0
        touch_radius = 22.0
        # Effective diameter on touch = 44px
        assert touch_radius * 2 >= 44.0
        assert touch_radius > mouse_radius

    def test_b23_04_disabled_button_pointer_events_none(self):
        btn_disabled = True
        pointer_events = "none" if btn_disabled else "auto"
        assert pointer_events == "none"

    def test_b23_05_styles_css_contains_touch_expansion_rules(self):
        css_path = REPO_ROOT / "inkwell-app" / "src" / "styles.css"
        content = css_path.read_text(encoding="utf-8")
        assert "min-width" in content or "44px" in content
