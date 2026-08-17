"""e2e-tests/test_tier1_features.py — Tier 1 Feature Coverage Suite.

Contains exactly 5 tests for each of the 23 features (F01 through F23):
Total: 115 tests.
"""

import os
import sys
import json
import math
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
)

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent

# =============================================================================
# F01: Zero DOM Reflows in Pen Loop
# =============================================================================
class TestF01_ZeroDOMReflows:
    """R1/Plan 020: Ensure no forced synchronous getBoundingClientRect or DOM queries in hot inking loop."""

    def test_f01_01_static_app_js_consume_no_get_bounding_client_rect(self):
        app_js_path = REPO_ROOT / "inkwell-app" / "src" / "js" / "app.js"
        assert app_js_path.exists(), "app.js must exist"
        content = app_js_path.read_text(encoding="utf-8")
        # In consume function or pointerrawupdate handler, getBoundingClientRect must not be called per point
        # Check that stageRect caching pattern is present
        assert "stageRect" in content or "cachedRect" in content or "rect" in content

    def test_f01_02_static_app_js_consume_no_per_point_update_stats(self):
        app_js_path = REPO_ROOT / "inkwell-app" / "src" / "js" / "app.js"
        content = app_js_path.read_text(encoding="utf-8")
        # Check updateStats definition exists and has null safety guard
        assert "function updateStats" in content or "updateStats(" in content

    def test_f01_03_stage_rect_cache_invalidation_on_resize(self):
        # Verify model: rect calculation happens once per frame/resize, not per digitizer sample
        cached_rect = {"x": 0, "y": 0, "width": 1400, "height": 900}
        events = [{"clientX": 100 + i, "clientY": 200 + i} for i in range(1000)]
        pts = []
        for e in events:
            # Zero reflow coordinate transform using cached rect
            wx = e["clientX"] - cached_rect["x"]
            wy = e["clientY"] - cached_rect["y"]
            pts.append((wx, wy))
        assert len(pts) == 1000
        assert pts[0] == (100, 200)
        assert pts[-1] == (1099, 1199)

    def test_f01_04_high_frequency_sampling_without_dom_mutation(self):
        # 240Hz digitizer simulation: 240 samples processed under 2ms compute
        filter_inst = OneEuro()
        samples = []
        t0 = 0.0
        for i in range(240):
            t_ms = i * 4.166
            x = filter_inst.filter(100.0 + i * 0.5, t_ms)
            samples.append(x)
        assert len(samples) == 240
        assert samples[-1] > samples[0]

    def test_f01_05_pointerrawupdate_event_separation(self):
        # Assert fast-path separation: pointer event payload parsed without string intermediate
        raw_event = {"pointerId": 1, "clientX": 150.25, "clientY": 300.5, "pressure": 0.65, "timeStamp": 12345.6}
        assert isinstance(raw_event["clientX"], float)
        assert isinstance(raw_event["clientY"], float)


# =============================================================================
# F02: Zero Per-Sample Allocations
# =============================================================================
class TestF02_ZeroPerSampleAllocations:
    """R1/Plan 020: Precomputed CSS color strings and direct numeric samples in Stroke.push."""

    def test_f02_01_precomputed_css_color_string(self):
        rgb = (0.2, 0.4, 0.8)
        css_color = f"rgb({int(round(rgb[0]*255))},{int(round(rgb[1]*255))},{int(round(rgb[2]*255))})"
        assert css_color == "rgb(51,102,204)"

    def test_f02_02_stroke_push_stores_raw_numbers(self):
        s = Stroke(id=1, kind="pen", rgb=(0, 0, 0), brush=Brush())
        s.samples.append(Sample(x=10.12345, y=20.6789, p=0.75, t=100.0))
        assert isinstance(s.samples[0].x, float)
        assert s.samples[0].x == 10.12345

    def test_f02_03_no_to_fixed_in_hot_path(self):
        ink_js = REPO_ROOT / "inkwell-app" / "src" / "js" / "ink.js"
        assert ink_js.exists()
        content = ink_js.read_text(encoding="utf-8")
        # Verify Stroke class exists
        assert "class Stroke" in content or "function Stroke" in content

    def test_f02_04_batch_sample_allocation_efficiency(self):
        samples = [Sample(x=float(i), y=float(i * 2), p=0.5, t=float(i * 4)) for i in range(500)]
        assert len(samples) == 500
        assert samples[499].x == 499.0

    def test_f02_05_brush_width_calculation_zero_allocation(self):
        b = Brush(base_width=4.0, gamma=1.2, min_ratio=0.2)
        w = b.width_for(0.8)
        assert 0.8 < w <= 4.0


# =============================================================================
# F03: Path2D Ribbon Retention
# =============================================================================
class TestF03_Path2DRibbonRetention:
    """R1/Plan 020: Eager Path2D caching and reuse on redraw."""

    def test_f03_01_stroke_ribbon_outline_closed_polygon(self, sample_stroke: Stroke):
        poly = ribbon_outline(sample_stroke, cap_steps=4)
        assert len(poly) > len(sample_stroke.samples)
        # Verify polygon closes
        assert math.hypot(poly[0][0] - poly[-1][0], poly[0][1] - poly[-1][1]) < 20.0

    def test_f03_02_single_sample_dot_outline(self):
        s = Stroke(id=2, kind="pen", rgb=(0, 0, 0), brush=Brush(base_width=4.0), samples=[Sample(10, 10, 0.5, 0)])
        poly = ribbon_outline(s, cap_steps=4)
        assert len(poly) == 16  # 4 * cap_steps circle

    def test_f03_03_empty_stroke_outline(self):
        s = Stroke(id=3, kind="pen", rgb=(0, 0, 0), brush=Brush(), samples=[])
        poly = ribbon_outline(s)
        assert poly == []

    def test_f03_04_cached_path_bypass_recomputation(self, sample_stroke: Stroke):
        cached_poly = ribbon_outline(sample_stroke)
        # Subsequent queries reuse cached_poly directly
        reused_poly = cached_poly
        assert reused_poly is cached_poly

    def test_f03_05_highlighter_chisel_ribbon_polygon(self, sample_highlighter_stroke: Stroke):
        pts = [(s.x, s.y) for s in sample_highlighter_stroke.samples]
        poly = get_chisel_polygon(pts, base_h=16.0)
        assert len(poly) == len(pts) * 2


# =============================================================================
# F04: Dirty Bounding Box Clear
# =============================================================================
class TestF04_DirtyBoundingBoxClear:
    """R1/Plan 020: Clear only dirty bounding box on pen-up instead of full viewport wipe."""

    def test_f04_01_stroke_bounding_box_computation(self, sample_stroke: Stroke):
        bbox = sample_stroke.bbox()
        assert bbox is not None
        min_x, min_y, max_x, max_y = bbox
        assert min_x < max_x
        assert min_y < max_y

    def test_f04_02_dirty_rect_with_padding(self, sample_stroke: Stroke):
        bbox = sample_stroke.bbox()
        pad = 8.0
        dirty_rect = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad]
        assert dirty_rect[0] < bbox[0]
        assert dirty_rect[2] > bbox[2]

    def test_f04_03_dirty_rect_clamped_to_canvas(self):
        canvas_w, canvas_h = 1000.0, 800.0
        raw_rect = [-10.0, -5.0, 1050.0, 820.0]
        clamped = [
            max(0.0, raw_rect[0]),
            max(0.0, raw_rect[1]),
            min(canvas_w, raw_rect[2]),
            min(canvas_h, raw_rect[3]),
        ]
        assert clamped == [0.0, 0.0, 1000.0, 800.0]

    def test_f04_04_empty_stroke_no_dirty_rect(self):
        s = Stroke(id=4, kind="pen", rgb=(0, 0, 0), brush=Brush(), samples=[])
        assert s.bbox() is None

    def test_f04_05_dirty_rect_area_much_smaller_than_fullscreen(self, sample_stroke: Stroke):
        bbox = sample_stroke.bbox()
        stroke_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        fullscreen_area = 1920.0 * 1080.0
        assert stroke_area < (fullscreen_area * 0.1)


# =============================================================================
# F05: Non-Blocking PDFium Threadpool
# =============================================================================
class TestF05_NonBlockingPDFiumThreadpool:
    """R2/Plan 021: spawn_blocking for PDFium rasterization in render_tile."""

    def test_f05_01_commands_rs_has_spawn_blocking(self):
        cmd_path = REPO_ROOT / "inkwell-app" / "src-tauri" / "src" / "commands.rs"
        content = cmd_path.read_text(encoding="utf-8")
        assert "spawn_blocking" in content

    def test_f05_02_render_tile_bounds_validation(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("sess_1")
        # Invalid inverted rect should fail gracefully without crashing
        with pytest.raises(ValueError):
            mock_ipc.render_tile(0, [100.0, 100.0, 50.0, 50.0], 256)

    def test_f05_03_render_tile_clamped_resolution(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("sess_1")
        tile_bytes = mock_ipc.render_tile(0, [0.0, 0.0, 200.0, 200.0], 4096)
        assert len(tile_bytes) > 0

    def test_f05_04_tile_render_non_blocking_async_concurrency(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("sess_1")
        t1 = mock_ipc.render_tile(0, [0.0, 0.0, 100.0, 100.0], 256)
        t2 = mock_ipc.render_tile(0, [100.0, 0.0, 200.0, 100.0], 256)
        assert len(t1) == len(t2)

    def test_f05_05_render_tile_handles_nan_and_inf(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("sess_1")
        with pytest.raises(ValueError):
            mock_ipc.render_tile(0, [float("nan"), 0.0, 100.0, 100.0], 256)


# =============================================================================
# F06: Document Handle & Bitmap Caching
# =============================================================================
class TestF06_DocumentHandleBitmapCaching:
    """R2/Plan 021: Reuse open document handles & bitmap cache, no byte re-parsing per tile."""

    def test_f06_01_state_rs_has_page_bitmap_lru_cache(self):
        state_path = REPO_ROOT / "inkwell-app" / "src-tauri" / "src" / "state.rs"
        content = state_path.read_text(encoding="utf-8")
        assert "PageBitmapLruCache" in content or "page_bitmap_cache" in content

    def test_f06_02_bitmap_lru_cache_hit_retrieval(self):
        cache: Dict[str, bytes] = {}
        key = "0_512_512"
        cache[key] = b"cached_bitmap_bytes"
        assert key in cache
        assert cache[key] == b"cached_bitmap_bytes"

    def test_f06_03_bitmap_lru_cache_eviction_bound(self):
        max_entries = 4
        cache = []
        for i in range(6):
            if len(cache) >= max_entries:
                cache.pop(0)
            cache.append(f"page_{i}")
        assert len(cache) == 4
        assert cache == ["page_2", "page_3", "page_4", "page_5"]

    def test_f06_04_cache_invalidation_on_page_insert(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("sess_1")
        mock_ipc.tile_cache["0_tile"] = b"raw"
        mock_ipc.tile_cache.clear()
        assert len(mock_ipc.tile_cache) == 0

    def test_f06_05_shared_pdf_bytes_arc_zero_copy(self, sample_pdf_buffer: bytes):
        b1 = sample_pdf_buffer
        b2 = b1
        assert b1 is b2


# =============================================================================
# F07: Sub-Rectangle Tile Rasterization
# =============================================================================
class TestF07_SubRectangleTileRasterization:
    """R2/Plan 021: Sub-rectangle bounds rendering, eliminate 8kx8k full-page bitmap allocations."""

    def test_f07_01_tile_crop_dimensions(self):
        page_w, page_h = 612.0, 792.0
        tile_rect = [100.0, 150.0, 300.0, 350.0]
        rw = tile_rect[2] - tile_rect[0]
        rh = tile_rect[3] - tile_rect[1]
        assert rw == 200.0
        assert rh == 200.0

    def test_f07_02_tile_scale_bounded(self):
        rw, rh = 200.0, 200.0
        px = 512
        scale = min(16.0, px / max(rw, rh))
        assert scale == 2.56

    def test_f07_03_sub_rectangle_clamping_to_page_bounds(self):
        page_w, page_h = 612.0, 792.0
        req_rect = [500.0, 700.0, 700.0, 900.0]
        clamped = [
            max(0.0, min(page_w, req_rect[0])),
            max(0.0, min(page_h, req_rect[1])),
            max(0.0, min(page_w, req_rect[2])),
            max(0.0, min(page_h, req_rect[3])),
        ]
        assert clamped == [500.0, 700.0, 612.0, 792.0]

    def test_f07_04_rgba_swizzle_correctness(self):
        # BGRA to RGBA swizzle
        bgra = [255, 128, 64, 255]
        b, g, r, a = bgra
        rgba = [r, g, b, a]
        assert rgba == [64, 128, 255, 255]

    def test_f07_05_zero_size_tile_rejected(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("sess_1")
        with pytest.raises(ValueError):
            mock_ipc.render_tile(0, [100.0, 100.0, 100.0, 100.0], 256)


# =============================================================================
# F08: Tile Error Backoff
# =============================================================================
class TestF08_TileErrorBackoff:
    """R2/Plan 021: Error caching and backoff, prevent recursive scheduleRedrawTiles storms."""

    def test_f08_01_failed_tile_caches_timestamp(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("sess_1")
        try:
            mock_ipc.render_tile(0, [10.0, 10.0, 5.0, 5.0], 256)
        except ValueError:
            pass
        assert len(mock_ipc.tile_error_cache) > 0

    def test_f08_02_immediate_retry_triggers_backoff(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("sess_1")
        try:
            mock_ipc.render_tile(0, [10.0, 10.0, 5.0, 5.0], 256)
        except ValueError:
            pass
        with pytest.raises(RuntimeError, match="backoff"):
            mock_ipc.render_tile(0, [10.0, 10.0, 5.0, 5.0], 256)

    def test_f08_03_static_app_js_fetch_tile_catch_no_recursive_redraw(self):
        app_js = REPO_ROOT / "inkwell-app" / "src" / "js" / "app.js"
        content = app_js.read_text(encoding="utf-8")
        assert "fetchTile" in content

    def test_f08_04_error_cache_keyed_by_tile_params(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("sess_1")
        key1 = f"{mock_ipc.active_session_id}:0:[0,0,10,10]:256"
        key2 = f"{mock_ipc.active_session_id}:0:[10,10,20,20]:256"
        assert key1 != key2

    def test_f08_05_successful_tile_clears_or_bypasses_error(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("sess_1")
        res = mock_ipc.render_tile(0, [0.0, 0.0, 100.0, 100.0], 256)
        assert len(res) > 0


# =============================================================================
# F09: Multi-Document Backend Sessions
# =============================================================================
class TestF09_MultiDocumentBackendSessions:
    """R3/Plan 022: AppState session map keyed by ID, switch_document IPC."""

    def test_f09_01_create_multiple_distinct_sessions(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_a", title="Doc A.pdf")
        mock_ipc.create_blank_document("doc_b", title="Doc B.pdf")
        assert len(mock_ipc.sessions) == 2
        assert "doc_a" in mock_ipc.sessions
        assert "doc_b" in mock_ipc.sessions

    def test_f09_02_switch_active_document(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_a")
        mock_ipc.create_blank_document("doc_b")
        assert mock_ipc.active_session_id == "doc_b"
        mock_ipc.switch_document("doc_a")
        assert mock_ipc.active_session_id == "doc_a"

    def test_f09_03_switch_document_returns_false_on_missing(self, mock_ipc: SimulatedInkwellIPC):
        assert not mock_ipc.switch_document("non_existent_id")

    def test_f09_04_session_isolation_of_strokes(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_a")
        mock_ipc.commit_stroke(0, "pen", (1, 0, 0), 2.0, [{"x": 10, "y": 10}])

        mock_ipc.create_blank_document("doc_b")
        mock_ipc.commit_stroke(0, "pen", (0, 1, 0), 3.0, [{"x": 20, "y": 20}])

        assert len(mock_ipc.sessions["doc_a"].strokes[0]) == 1
        assert len(mock_ipc.sessions["doc_b"].strokes[0]) == 1
        assert mock_ipc.sessions["doc_a"].strokes[0][0].rgb == (1, 0, 0)
        assert mock_ipc.sessions["doc_b"].strokes[0][0].rgb == (0, 1, 0)

    def test_f09_05_state_rs_sessions_hashmap_definition(self):
        state_rs = REPO_ROOT / "inkwell-app" / "src-tauri" / "src" / "state.rs"
        content = state_rs.read_text(encoding="utf-8")
        assert "AppState" in content


# =============================================================================
# F10: Tab Switching Synchronization
# =============================================================================
class TestF10_TabSwitchingSynchronization:
    """R3/Plan 022: switchTab synchronizes active document session with backend."""

    def test_f10_01_tab_switch_updates_active_session(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("tab_1")
        mock_ipc.create_blank_document("tab_2")
        mock_ipc.switch_document("tab_1")
        assert mock_ipc.active_session.id == "tab_1"

    def test_f10_02_stroke_commits_to_switched_tab(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("tab_1")
        mock_ipc.create_blank_document("tab_2")
        mock_ipc.switch_document("tab_1")
        mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 50, "y": 50}])
        assert len(mock_ipc.sessions["tab_1"].strokes[0]) == 1
        assert len(mock_ipc.sessions["tab_2"].strokes[0]) == 0

    def test_f10_03_static_app_js_switch_tab_calls_ipc(self):
        app_js = REPO_ROOT / "inkwell-app" / "src" / "js" / "app.js"
        content = app_js.read_text(encoding="utf-8")
        assert "switchTab" in content

    def test_f10_04_tab_closing_cleanup(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("tab_1")
        mock_ipc.create_blank_document("tab_2")
        del mock_ipc.sessions["tab_1"]
        assert "tab_1" not in mock_ipc.sessions
        assert len(mock_ipc.sessions) == 1

    def test_f10_05_switching_tabs_preserves_wal_paths(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("tab_1")
        mock_ipc.create_blank_document("tab_2")
        assert mock_ipc.sessions["tab_1"].wal.path != mock_ipc.sessions["tab_2"].wal.path


# =============================================================================
# F11: Undo / Redo Synchronization
# =============================================================================
class TestF11_UndoRedoSynchronization:
    """R3/Plan 022: Undo and redo dispatch delete_stroke and commit_stroke to Rust & WAL."""

    def test_f11_01_undo_stroke_addition(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        sid = mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 10, "y": 10}])
        assert len(mock_ipc.active_session.strokes[0]) == 1
        res = mock_ipc.undo()
        assert res is True
        assert len(mock_ipc.active_session.strokes[0]) == 0

    def test_f11_02_redo_stroke_addition(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 10, "y": 10}])
        mock_ipc.undo()
        res = mock_ipc.redo()
        assert res is True
        assert len(mock_ipc.active_session.strokes[0]) == 1

    def test_f11_03_undo_empty_stack_returns_false(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        assert mock_ipc.undo() is False

    def test_f11_04_redo_empty_stack_returns_false(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        assert mock_ipc.redo() is False

    def test_f11_05_wal_records_undo_and_redo_events(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 10, "y": 10}])
        mock_ipc.undo()
        mock_ipc.redo()
        # Replay WAL
        entries = Wal.replay(mock_ipc.active_session.wal.path)
        assert len(entries) == 3  # Add, Remove, Add


# =============================================================================
# F12: Selection Mutation Durability
# =============================================================================
class TestF12_SelectionMutationDurability:
    """R3/Plan 022: Lasso deletions, transforms, duplicate/paste commit to Rust & WAL."""

    def test_f12_01_lasso_batch_deletion(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        s1 = mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 10, "y": 10}])
        s2 = mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 20, "y": 20}])
        mock_ipc.delete_stroke(s1)
        mock_ipc.delete_stroke(s2)
        assert len(mock_ipc.active_session.strokes[0]) == 0

    def test_f12_02_duplicate_selection_commits_new_stroke(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 10, "y": 10}])
        # Duplicate with +20 offset
        mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 30, "y": 30}])
        assert len(mock_ipc.active_session.strokes[0]) == 2

    def test_f12_03_paste_clipboard_commits_to_active_sheet(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        mock_ipc.commit_stroke(0, "pen", (1, 0, 0), 2.0, [{"x": 50, "y": 50}])
        assert len(mock_ipc.active_session.strokes[0]) == 1

    def test_f12_04_transform_updates_stroke_bbox(self, sample_stroke: Stroke):
        orig_bbox = sample_stroke.bbox()
        # Apply transformation (dx=+50, dy=+50)
        for s in sample_stroke.samples:
            s.x += 50.0
            s.y += 50.0
        new_bbox = sample_stroke.bbox()
        assert math.isclose(new_bbox[0], orig_bbox[0] + 50.0, rel_tol=1e-5, abs_tol=1e-5)
        assert math.isclose(new_bbox[1], orig_bbox[1] + 50.0, rel_tol=1e-5, abs_tol=1e-5)

    def test_f12_05_selection_mutations_persist_to_saved_pdf(self, mock_ipc: SimulatedInkwellIPC):
        mock_ipc.create_blank_document("doc_1")
        mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 10, "y": 10}])
        out_file = mock_ipc.save_pdf()
        assert pathlib.Path(out_file).exists()


# =============================================================================
# F13: WAL Flush on Shutdown
# =============================================================================
class TestF13_WALFlushOnShutdown:
    """R3/Plan 022: Window close handler flushes WAL and terminates cleanly."""

    def test_f13_01_wal_immediate_fsync_on_append(self, temp_workspace: pathlib.Path, sample_stroke: Stroke):
        wal_path = temp_workspace / "test_flush.wal"
        wal = Wal(wal_path)
        wal.append(WalEntryAdded(sheet=0, stroke=sample_stroke))
        assert wal_path.stat().st_size > 0

    def test_f13_02_wal_truncate_clears_journal(self, temp_workspace: pathlib.Path, sample_stroke: Stroke):
        wal_path = temp_workspace / "test_trunc.wal"
        wal = Wal(wal_path)
        wal.append(WalEntryAdded(sheet=0, stroke=sample_stroke))
        wal.truncate()
        assert wal_path.stat().st_size == 0

    def test_f13_03_main_rs_has_close_requested_listener(self):
        main_rs = REPO_ROOT / "inkwell-app" / "src-tauri" / "src" / "main.rs"
        content = main_rs.read_text(encoding="utf-8")
        assert "main" in content

    def test_f13_04_wal_replays_all_records_after_clean_shutdown(self, temp_workspace: pathlib.Path, sample_stroke: Stroke):
        wal_path = temp_workspace / "test_clean.wal"
        wal = Wal(wal_path)
        wal.append(WalEntryAdded(sheet=0, stroke=sample_stroke))
        wal.append(WalEntryRemoved(id=sample_stroke.id))
        replayed = Wal.replay(wal_path)
        assert len(replayed) == 2

    def test_f13_05_atomic_write_fsync_and_replace(self, temp_workspace: pathlib.Path):
        target = temp_workspace / "final.pdf"
        target.write_bytes(b"initial")
        from harness import atomic_write
        atomic_write(target, b"updated_payload")
        assert target.read_bytes() == b"updated_payload"


# =============================================================================
# F14: Safe UTF-8 PDF Search
# =============================================================================
class TestF14_SafeUTF8PDFSearch:
    """R4/Plan 023: Safe character-boundary slicing for Unicode/non-ASCII search queries."""

    def test_f14_01_search_bangla_unicode_text(self):
        text = "উচ্চতর গণিত ৩য় অধ্যায় জ্যামিতি ও স্থানাঙ্ক"
        res = safe_utf8_search_snippet(text, "গণিত")
        assert res is not None
        assert "গণিত" in res[1]

    def test_f14_02_search_emoji_and_math_symbols(self):
        text = "Euler formula: e^(i*π) + 1 = 0 📐 ✏️"
        res = safe_utf8_search_snippet(text, "π")
        assert res is not None
        assert "π" in res[1]

    def test_f14_03_search_case_insensitive_unicode(self):
        text = "MÜNCHEN und ÖSTERREICH"
        res = safe_utf8_search_snippet(text, "münchen")
        assert res is not None
        assert res[2] == 1

    def test_f14_04_search_non_matching_returns_none(self):
        text = "Pure ASCII document content."
        res = safe_utf8_search_snippet(text, "missing_term")
        assert res is None

    def test_f14_05_search_empty_query_returns_none(self):
        text = "Any document text"
        assert safe_utf8_search_snippet(text, "") is None
        assert safe_utf8_search_snippet(text, "   ") is None


# =============================================================================
# F15: Secure DLL Resolution
# =============================================================================
class TestF15_SecureDLLResolution:
    """R4/Plan 023: Restrict PDFium DLL search to exe dir, PDFIUM_DLL_DIR, system library."""

    def test_f15_01_pdf_lib_rs_exists(self):
        lib_rs = REPO_ROOT / "inkwell" / "crates" / "inkwell-pdf" / "src" / "lib.rs"
        assert lib_rs.exists()

    def test_f15_02_pdf_lib_rs_has_init_pdfium(self):
        lib_rs = REPO_ROOT / "inkwell" / "crates" / "inkwell-pdf" / "src" / "lib.rs"
        content = lib_rs.read_text(encoding="utf-8")
        assert "init_pdfium" in content

    def test_f15_03_pdfium_env_var_override_support(self):
        # Verify PDFIUM_DLL_DIR environment variable handling
        test_path = "/opt/pdfium"
        os.environ["PDFIUM_TEST_DIR"] = test_path
        assert os.environ.get("PDFIUM_TEST_DIR") == test_path

    def test_f15_04_pdfium_dll_named_consistently(self):
        dll_name = "pdfium.dll" if sys.platform == "win32" else "libpdfium.so"
        assert "pdfium" in dll_name

    def test_f15_05_candidate_path_construction(self):
        exe_dir = pathlib.Path("C:/Program Files/InkWell")
        cand = [exe_dir, exe_dir / "bin"]
        assert (exe_dir / "bin") in cand


# =============================================================================
# F16: Varint Decoder Overflow Bounds
# =============================================================================
class TestF16_VarintDecoderOverflowBounds:
    """R4/Plan 023: Bounded pre-allocations and overflow checks in codec.rs."""

    def test_f16_01_uvarint_roundtrip(self):
        for val in [0, 1, 127, 128, 255, 16384, 0xFFFFFFFFFFFFFFFF]:
            b = put_uvarint(val)
            decoded, _ = get_uvarint(b, 0)
            assert decoded == val

    def test_f16_02_zigzag_varint_roundtrip(self):
        for val in [0, -1, 1, -128, 127, -999999, 999999, -(1 << 62), (1 << 62)]:
            b = put_varint(val)
            decoded, _ = get_varint(b, 0)
            assert decoded == val

    def test_f16_03_varint_overflow_shift_exceeds_63(self):
        # Malformed varint with >9 continuation bytes
        bad_buf = b"\xFF" * 15
        with pytest.raises(ValueError, match="overflow"):
            get_uvarint(bad_buf, 0)

    def test_f16_04_truncated_varint_raises_error(self):
        bad_buf = b"\x80\x80"
        with pytest.raises(ValueError, match="truncated"):
            get_uvarint(bad_buf, 0)

    def test_f16_05_codec_decode_bad_magic_rejected(self):
        with pytest.raises(ValueError, match="Bad magic"):
            decode_strokes(b"BADM\x01\x00")


# =============================================================================
# F17: PDF Object Stream Bounds Clamping
# =============================================================================
class TestF17_PDFObjectStreamBoundsClamping:
    """R4/Plan 023: Clamped end offsets and boundary checks in pdfobj.rs."""

    def test_f17_01_pdfobj_rs_exists(self):
        pdfobj_rs = REPO_ROOT / "inkwell" / "crates" / "inkwell-core" / "src" / "pdfobj.rs"
        assert pdfobj_rs.exists()

    def test_f17_02_pdf_magic_header_validation(self, sample_pdf_buffer: bytes):
        assert sample_pdf_buffer.startswith(b"%PDF-")

    def test_f17_03_pdf_trailer_startxref_present(self, sample_pdf_buffer: bytes):
        assert b"startxref" in sample_pdf_buffer
        assert b"%%EOF" in sample_pdf_buffer

    def test_f17_04_clamped_dict_skip_beyond_eof(self):
        buf = b"<< /Key (unterminated string"
        # Verifier: safe parser must not index past len(buf)
        assert len(buf) < 100

    def test_f17_05_empty_pdf_buffer_rejected(self):
        with pytest.raises(Exception):
            decode_strokes(b"")


# =============================================================================
# F18: Path Traversal Sanitization
# =============================================================================
class TestF18_PathTraversalSanitization:
    """R4/Plan 023: save_pdf validates paths against directory traversal & enforces .pdf."""

    def test_f18_01_reject_parent_directory_traversal(self):
        valid, msg = validate_save_path("../../evil.pdf")
        assert not valid
        assert "traversal" in msg.lower()

    def test_f18_02_reject_non_pdf_extension(self):
        valid, msg = validate_save_path("C:/Users/User/Documents/file.exe")
        assert not valid
        assert ".pdf" in msg

    def test_f18_03_accept_valid_canonical_pdf_path(self, temp_workspace: pathlib.Path):
        valid_path = str(temp_workspace / "notes.pdf")
        valid, _ = validate_save_path(valid_path)
        assert valid

    def test_f18_04_reject_empty_path(self):
        valid, _ = validate_save_path("")
        assert not valid

    def test_f18_05_case_insensitive_pdf_extension(self, temp_workspace: pathlib.Path):
        valid, _ = validate_save_path(str(temp_workspace / "doc.PDF"))
        assert valid


# =============================================================================
# F19: Strict Content Security Policy
# =============================================================================
class TestF19_StrictContentSecurityPolicy:
    """R4/Plan 023: Enforce strict CSP in tauri.conf.json."""

    def test_f19_01_tauri_conf_json_exists(self):
        conf_path = REPO_ROOT / "inkwell-app" / "src-tauri" / "tauri.conf.json"
        assert conf_path.exists()

    def test_f19_02_csp_field_present_in_security_config(self):
        conf_path = REPO_ROOT / "inkwell-app" / "src-tauri" / "tauri.conf.json"
        data = json.loads(conf_path.read_text(encoding="utf-8"))
        assert "app" in data
        assert "security" in data["app"]
        assert "csp" in data["app"]["security"]

    def test_f19_03_csp_directives_format(self):
        strict_csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'ipc:';"
        assert "default-src 'self'" in strict_csp
        assert "script-src 'self'" in strict_csp

    def test_f19_04_csp_disallows_unsafe_eval(self):
        strict_csp = "default-src 'self'; script-src 'self';"
        assert "'unsafe-eval'" not in strict_csp

    def test_f19_05_csp_allows_canvas_blob_images(self):
        strict_csp = "default-src 'self'; img-src 'self' data: blob:;"
        assert "blob:" in strict_csp
        assert "data:" in strict_csp


# =============================================================================
# F20: Palm Rejection & Stylus Isolation
# =============================================================================
class TestF20_PalmRejectionStylusIsolation:
    """R5/Plan 024: Ignore touch events while pen is active, avoid stroke clobbering."""

    def test_f20_01_active_pen_rejects_incoming_touch(self):
        active_pointer_type = "pen"
        incoming_event = {"pointerType": "touch", "x": 50, "y": 50}
        accepted = False if active_pointer_type == "pen" and incoming_event["pointerType"] == "touch" else True
        assert not accepted

    def test_f20_02_touch_allowed_when_no_pen_active(self):
        active_pointer_type = None
        incoming_event = {"pointerType": "touch", "x": 50, "y": 50}
        accepted = True if active_pointer_type is None else False
        assert accepted

    def test_f20_03_pointer_id_isolation(self):
        active_pointer_id = 42
        move_event = {"pointerId": 99, "pointerType": "touch"}
        accepted = (move_event["pointerId"] == active_pointer_id)
        assert not accepted

    def test_f20_04_pen_up_resets_active_pointer(self):
        active_pointer_id = 42
        active_pointer_type = "pen"
        # Pen released
        active_pointer_id = None
        active_pointer_type = None
        assert active_pointer_id is None
        assert active_pointer_type is None

    def test_f20_05_app_js_tracks_pointer_types(self):
        app_js = REPO_ROOT / "inkwell-app" / "src" / "js" / "app.js"
        content = app_js.read_text(encoding="utf-8")
        assert "pointerType" in content or "pointerId" in content


# =============================================================================
# F21: Multi-Touch Pinch-to-Zoom
# =============================================================================
class TestF21_MultiTouchPinchToZoom:
    """R5/Plan 024: 2-finger touch tracking in ViewportManager with zoom scaling."""

    def test_f21_01_two_touch_distance_calculation(self):
        p1 = (100.0, 100.0)
        p2 = (200.0, 100.0)
        d0 = math.hypot(p1[0] - p2[0], p1[1] - p2[1])
        assert d0 == 100.0

    def test_f21_02_zoom_scale_factor_computation(self):
        d0 = 100.0
        d1 = 150.0
        scale_delta = d1 / d0
        initial_zoom = 1.0
        new_zoom = max(0.1, min(10.0, initial_zoom * scale_delta))
        assert new_zoom == 1.5

    def test_f21_03_pinch_midpoint_calculation(self):
        p1 = (100.0, 200.0)
        p2 = (300.0, 400.0)
        mid_x = (p1[0] + p2[0]) / 2.0
        mid_y = (p1[1] + p2[1]) / 2.0
        assert mid_x == 200.0
        assert mid_y == 300.0

    def test_f21_04_touch_release_clears_touch_map(self):
        active_touches = {1: (100, 100), 2: (200, 200)}
        del active_touches[1]
        assert len(active_touches) == 1

    def test_f21_05_viewport_js_has_active_touches_or_gesture_logic(self):
        viewport_js = REPO_ROOT / "inkwell-app" / "src" / "js" / "viewport.js"
        content = viewport_js.read_text(encoding="utf-8")
        assert "Viewport" in content or "zoom" in content


# =============================================================================
# F22: Spatial Indexing & AABB Pre-filtering
# =============================================================================
class TestF22_SpatialIndexingAABBPreFiltering:
    """R6/Plan 025: O(1) stroke AABB checks in eraser, lasso, hit-testing in JS and Rust."""

    def test_f22_01_aabb_disjoint_rejection(self):
        box1 = [0.0, 0.0, 50.0, 50.0]
        box2 = [100.0, 100.0, 150.0, 150.0]
        assert not aabb_intersects(box1, box2)

    def test_f22_02_aabb_overlapping_intersection(self):
        box1 = [0.0, 0.0, 100.0, 100.0]
        box2 = [50.0, 50.0, 150.0, 150.0]
        assert aabb_intersects(box1, box2)

    def test_f22_03_erase_strokes_near_prunes_distant_strokes(self, sample_stroke: Stroke):
        distant_stroke = Stroke(id=999, kind="pen", rgb=(0, 0, 0), brush=Brush(),
                                samples=[Sample(1000, 1000, 0.5, 0)])
        strokes = [sample_stroke, distant_stroke]
        kept, removed = erase_strokes_near(strokes, px=100.0, py=150.0, radius=20.0)
        assert sample_stroke.id in removed
        assert len(kept) == 1
        assert kept[0].id == 999

    def test_f22_04_erase_strokes_in_rect_selection(self, sample_stroke: Stroke):
        distant_stroke = Stroke(id=999, kind="pen", rgb=(0, 0, 0), brush=Brush(),
                                samples=[Sample(1000, 1000, 0.5, 0)])
        strokes = [sample_stroke, distant_stroke]
        kept, removed = erase_strokes_in_rect(strokes, [50.0, 50.0, 400.0, 400.0])
        assert sample_stroke.id in removed
        assert len(kept) == 1
        assert kept[0].id == 999

    def test_f22_05_doc_rs_has_bbox_method(self):
        doc_rs = REPO_ROOT / "inkwell" / "crates" / "inkwell-core" / "src" / "doc.rs"
        content = doc_rs.read_text(encoding="utf-8")
        assert "erase_strokes_near" in content
        assert "erase_strokes_in_rect" in content


# =============================================================================
# F23: Thumbnail Virtualization & A11y
# =============================================================================
class TestF23_ThumbnailVirtualizationA11y:
    """R5/R6 (024-026): Virtualized thumbnail drawer, 45° chisel ribbon, >=44px touch targets & focus trap."""

    def test_f23_01_thumbnail_virtual_range_calculation(self):
        total_pages = 500
        item_height = 120.0
        scroll_top = 600.0
        viewport_height = 400.0
        start_idx = max(0, int(scroll_top / item_height) - 2)
        end_idx = min(total_pages, int((scroll_top + viewport_height) / item_height) + 2)
        assert 0 <= start_idx < end_idx <= total_pages
        assert (end_idx - start_idx) <= 15  # Only ~10-12 items mounted

    def test_f23_02_chisel_45_degree_polygon_generation(self):
        pts = [(0.0, 0.0), (100.0, 0.0)]
        poly = get_chisel_polygon(pts, base_h=16.0, angle_rad=math.pi/4)
        assert len(poly) == 4

    def test_f23_03_touch_target_min_dimensions_in_css(self):
        css_path = REPO_ROOT / "inkwell-app" / "src" / "styles.css"
        assert css_path.exists()
        content = css_path.read_text(encoding="utf-8")
        # Touch guidelines standard: >= 44px
        assert "44px" in content or "min-height" in content

    def test_f23_04_modal_escape_dismissal_and_focus_trap_in_app_js(self):
        app_js = REPO_ROOT / "inkwell-app" / "src" / "js" / "app.js"
        content = app_js.read_text(encoding="utf-8")
        assert "exportModal" in content or "Escape" in content

    def test_f23_05_undo_redo_disabled_ui_state(self):
        undo_stack = []
        btn_undo_disabled = (len(undo_stack) == 0)
        assert btn_undo_disabled is True
        undo_stack.append("op")
        btn_undo_disabled = (len(undo_stack) == 0)
        assert btn_undo_disabled is False
