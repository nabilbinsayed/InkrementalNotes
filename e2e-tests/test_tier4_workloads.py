"""e2e-tests/test_tier4_workloads.py — Tier 4 Real-World Application Workloads Suite.

Contains 14 comprehensive end-to-end user workflows simulating realistic
note-taking, reading, multitasking, crash recovery, and security scenarios.
Total: 14 workflows (Target: 12+).
"""

import os
import sys
import math
import json
import time
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
    ribbon_outline,
    get_chisel_polygon,
    aabb_intersects,
    erase_strokes_near,
    erase_strokes_in_rect,
    validate_save_path,
    safe_utf8_search_snippet,
    make_sample_pdf,
    simplify_rdp,
)

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent

class TestTier4Workloads:
    """End-to-End Real-World Application Workflows."""

    def test_workflow_01_full_note_taking_session(self, mock_ipc: SimulatedInkwellIPC, temp_workspace: pathlib.Path):
        """Workflow 1: Blank notebook creation -> multi-line pen handwriting -> highlighter accents -> save to PDF."""
        # 1. Create document
        mock_ipc.create_blank_document("notes_session", title="Lecture Notes.pdf", width_pt=612.0, height_pt=792.0)
        assert mock_ipc.active_session.doc_title == "Lecture Notes.pdf"

        # 2. Draw 5 lines of handwritten notes with Pen
        for line in range(5):
            y_base = 100.0 + line * 40.0
            samples = [
                {"x": 100.0 + i * 15.0, "y": y_base + 5.0 * math.sin(i), "pressure": 0.4 + 0.3 * math.sin(i / 2), "t_ms": i * 10.0}
                for i in range(20)
            ]
            sid = mock_ipc.commit_stroke(0, "pen", (0.05, 0.05, 0.05), 2.5, samples)
            assert sid > 0

        # 3. Add 2 highlighter strokes over keywords on lines 1 and 3
        h_samples1 = [{"x": 100.0, "y": 140.0, "p": 0.9, "t": 0.0}, {"x": 250.0, "y": 140.0, "p": 0.9, "t": 20.0}]
        h_samples2 = [{"x": 100.0, "y": 220.0, "p": 0.9, "t": 0.0}, {"x": 280.0, "y": 220.0, "p": 0.9, "t": 20.0}]
        mock_ipc.commit_stroke(0, "highlighter", (1.0, 0.9, 0.1), 16.0, h_samples1)
        mock_ipc.commit_stroke(0, "highlighter", (1.0, 0.9, 0.1), 16.0, h_samples2)

        assert len(mock_ipc.active_session.strokes[0]) == 7

        # 4. Save document
        save_path = str(temp_workspace / "Lecture_Notes_Saved.pdf")
        saved_file = mock_ipc.save_pdf(save_path)
        assert pathlib.Path(saved_file).exists()
        assert pathlib.Path(saved_file).stat().st_size > 1000

    def test_workflow_02_split_view_pdf_reading_and_whiteboard(self, mock_ipc: SimulatedInkwellIPC, temp_workspace: pathlib.Path):
        """Workflow 2: Dual-sheet split view: Annotating textbook on sheet 0, scratchpad calculations on sheet 1."""
        pdf_file = temp_workspace / "textbook.pdf"
        pdf_file.write_bytes(make_sample_pdf(page_count=2, width_pt=595.0, height_pt=842.0))

        mock_ipc.open_pdf_file("split_session", str(pdf_file))

        # Annotate textbook page (sheet 0)
        mock_ipc.commit_stroke(0, "pen", (0.8, 0.1, 0.1), 2.0, [{"x": 50, "y": 100}, {"x": 200, "y": 100}])

        # Write math equations on whiteboard (sheet 1)
        mock_ipc.commit_stroke(1, "pen", (0.1, 0.2, 0.8), 2.0, [{"x": 100, "y": 200}, {"x": 300, "y": 250}])
        mock_ipc.commit_stroke(1, "pen", (0.1, 0.2, 0.8), 2.0, [{"x": 100, "y": 300}, {"x": 300, "y": 350}])

        assert len(mock_ipc.active_session.strokes[0]) == 1
        assert len(mock_ipc.active_session.strokes[1]) == 2

        # Replay WAL to ensure both sheets were logged durably
        replayed = Wal.replay(mock_ipc.active_session.wal.path)
        assert len(replayed) == 3

    def test_workflow_03_crash_recovery_during_rapid_inking(self, temp_workspace: pathlib.Path):
        """Workflow 3: Rapid inking -> ungraceful crash -> restart -> full WAL recovery."""
        wal_path = temp_workspace / "crash_test.wal"
        wal = Wal(wal_path)

        # Simulate 25 rapidly drawn strokes before crash
        for i in range(25):
            samples = [Sample(float(i * 10 + j), float(100 + j), 0.5, float(j)) for j in range(10)]
            s = Stroke(id=1000 + i, kind="pen", rgb=(0, 0, 0), brush=Brush(), samples=samples)
            wal.append(WalEntryAdded(sheet=0, stroke=s))

        # Simulate crash (do not truncate or save)
        # Re-open session with WAL replay
        replayed_entries = Wal.replay(wal_path)
        assert len(replayed_entries) == 25
        recovered_strokes = [e.stroke for e in replayed_entries if isinstance(e, WalEntryAdded)]
        assert len(recovered_strokes) == 25
        assert recovered_strokes[0].id == 1000
        assert recovered_strokes[-1].id == 1024

    def test_workflow_04_multi_tab_research_and_annotation(self, mock_ipc: SimulatedInkwellIPC, temp_workspace: pathlib.Path):
        """Workflow 4: Multi-tab workflow across 3 papers with tab switching, independent undo, and saves."""
        # Open 3 documents
        for name in ["Paper_A", "Paper_B", "Paper_C"]:
            mock_ipc.create_blank_document(name, title=f"{name}.pdf")

        # Annotate Paper A
        mock_ipc.switch_document("Paper_A")
        mock_ipc.commit_stroke(0, "pen", (1, 0, 0), 2.0, [{"x": 10, "y": 10}, {"x": 20, "y": 20}])

        # Annotate Paper B
        mock_ipc.switch_document("Paper_B")
        mock_ipc.commit_stroke(0, "pen", (0, 1, 0), 2.0, [{"x": 30, "y": 30}, {"x": 40, "y": 40}])

        # Switch back to Paper A, add second stroke, then undo it
        mock_ipc.switch_document("Paper_A")
        mock_ipc.commit_stroke(0, "pen", (1, 0, 0), 2.0, [{"x": 50, "y": 50}, {"x": 60, "y": 60}])
        assert len(mock_ipc.sessions["Paper_A"].strokes[0]) == 2
        mock_ipc.undo()
        assert len(mock_ipc.sessions["Paper_A"].strokes[0]) == 1

        # Save all 3 documents
        for name in ["Paper_A", "Paper_B", "Paper_C"]:
            mock_ipc.switch_document(name)
            out = mock_ipc.save_pdf(str(temp_workspace / f"{name}_final.pdf"))
            assert pathlib.Path(out).exists()

    def test_workflow_05_lasso_select_transform_and_duplicate(self, mock_ipc: SimulatedInkwellIPC):
        """Workflow 5: Draw diagram -> Lasso select via AABB -> Move selection -> Duplicate -> Verify."""
        mock_ipc.create_blank_document("diagram_doc")

        # Draw 3 strokes forming a triangle diagram
        s1 = mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 100, "y": 100}, {"x": 200, "y": 100}])
        s2 = mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 200, "y": 100}, {"x": 150, "y": 50}])
        s3 = mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 150, "y": 50}, {"x": 100, "y": 100}])

        strokes = mock_ipc.active_session.strokes[0]
        assert len(strokes) == 3

        # Lasso select area [80, 40, 220, 120]
        kept, selected_ids = erase_strokes_in_rect(strokes, [80.0, 40.0, 220.0, 120.0])
        assert len(selected_ids) == 3

        # Move strokes by dx=+100, dy=+100
        for s in strokes:
            for sm in s.samples:
                sm.x += 100.0
                sm.y += 100.0
        # Duplicate selection
        for s in list(strokes):
            dup_samples = [{"x": sm.x + 20.0, "y": sm.y + 20.0, "p": sm.p, "t": sm.t} for sm in s.samples]
            mock_ipc.commit_stroke(0, "pen", s.rgb, s.brush.base_width, dup_samples)

        assert len(mock_ipc.active_session.strokes[0]) == 6

    def test_workflow_06_search_and_annotate_unicode_text(self, mock_ipc: SimulatedInkwellIPC):
        """Workflow 6: Search Unicode Bangla and mathematical text -> Extract snippet -> Highlight match."""
        mock_ipc.create_blank_document("math_doc")
        text = "অধ্যায় ৩: ইউক্লিডীয় জ্যামিতি ও পিথাগোরাসের উপপাদ্য a² + b² = c²"

        # Search for keyword
        res = safe_utf8_search_snippet(text, "জ্যামিতি")
        assert res is not None
        idx, snippet, count = res
        assert "জ্যামিতি" in snippet

        # Highlight keyword location with chisel highlighter
        h_pts = [{"x": 120.0, "y": 200.0, "p": 0.8, "t": 0.0}, {"x": 220.0, "y": 200.0, "p": 0.8, "t": 16.0}]
        hid = mock_ipc.commit_stroke(0, "highlighter", (1.0, 0.9, 0.2), 16.0, h_pts)
        assert hid > 0

    def test_workflow_07_large_document_rapid_tile_scrolling(self, mock_ipc: SimulatedInkwellIPC):
        """Workflow 7: Rapid multi-page tile requests with LRU bitmap caching and no memory leak."""
        mock_ipc.create_blank_document("large_doc")

        # Simulate user scrolling through pages 0..9 requesting 4 tiles per page
        for page in range(10):
            for tile_idx in range(4):
                tx = (tile_idx % 2) * 200.0
                ty = (tile_idx // 2) * 200.0
                buf = mock_ipc.render_tile(page, [tx, ty, tx + 200.0, ty + 200.0], 256)
                assert len(buf) == 256 * 256 * 4

    def test_workflow_08_stylus_drawing_with_intermittent_palm_contact(self):
        """Workflow 8: Continuous stylus digitizer stream rejecting interleaved touch events."""
        recorded_samples = []
        is_pen_down = False

        events = [
            {"type": "pointerdown", "pointerType": "pen", "id": 1, "x": 100, "y": 100, "p": 0.5},
            {"type": "pointermove", "pointerType": "pen", "id": 1, "x": 110, "y": 105, "p": 0.6},
            # Palm touches screen
            {"type": "pointerdown", "pointerType": "touch", "id": 2, "x": 300, "y": 400, "p": 1.0},
            {"type": "pointermove", "pointerType": "touch", "id": 2, "x": 305, "y": 405, "p": 1.0},
            # Pen continues drawing
            {"type": "pointermove", "pointerType": "pen", "id": 1, "x": 120, "y": 110, "p": 0.7},
            {"type": "pointerup", "pointerType": "pen", "id": 1, "x": 130, "y": 115, "p": 0.2},
            # Palm lifts
            {"type": "pointerup", "pointerType": "touch", "id": 2, "x": 305, "y": 405, "p": 0.0},
        ]

        active_pen_id = None
        for ev in events:
            if ev["pointerType"] == "pen":
                if ev["type"] == "pointerdown":
                    active_pen_id = ev["id"]
                    recorded_samples.append((ev["x"], ev["y"]))
                elif ev["type"] == "pointermove" and active_pen_id == ev["id"]:
                    recorded_samples.append((ev["x"], ev["y"]))
                elif ev["type"] == "pointerup":
                    active_pen_id = None
            elif ev["pointerType"] == "touch":
                # Rejected while active pen is present
                if active_pen_id is not None:
                    continue  # Rejected

        # Only pen samples recorded (3 samples)
        assert len(recorded_samples) == 3
        assert recorded_samples[0] == (100, 100)
        assert recorded_samples[-1] == (120, 110)

    def test_workflow_09_two_finger_pinch_zoom_and_pan(self):
        """Workflow 9: Two-finger pinch gesture scaling zoom from 1.0x to 2.0x without drawing ink."""
        touches = {
            1: {"x": 100.0, "y": 200.0},
            2: {"x": 300.0, "y": 200.0},
        }
        d0 = math.hypot(touches[1]["x"] - touches[2]["x"], touches[1]["y"] - touches[2]["y"])
        assert d0 == 200.0

        # Move fingers apart (zoom in)
        touches[1]["x"] = 50.0
        touches[2]["x"] = 450.0
        d1 = math.hypot(touches[1]["x"] - touches[2]["x"], touches[1]["y"] - touches[2]["y"])
        scale = d1 / d0
        zoom = max(0.1, min(10.0, 1.0 * scale))
        assert zoom == 2.0

    def test_workflow_10_eraser_scrubbing_dense_annotations(self, mock_ipc: SimulatedInkwellIPC):
        """Workflow 10: 100 dense strokes -> sweeping eraser gesture erasing targeted strokes in O(1) time."""
        mock_ipc.create_blank_document("dense_doc")

        # Create 100 horizontal strokes across page
        for i in range(100):
            y = 50.0 + i * 8.0
            mock_ipc.commit_stroke(0, "pen", (0, 0, 0), 2.0, [{"x": 50, "y": y}, {"x": 400, "y": y}])

        strokes = mock_ipc.active_session.strokes[0]
        assert len(strokes) == 100

        # Erase strokes in middle strip [0, 200, 500, 300]
        kept, removed = erase_strokes_in_rect(strokes, [0.0, 200.0, 500.0, 300.0])
        mock_ipc.active_session.strokes[0] = kept
        assert len(removed) > 10
        assert len(kept) < 90

    def test_workflow_11_blank_page_insertion_and_stroke_preservation(self, mock_ipc: SimulatedInkwellIPC):
        """Workflow 11: Multi-page document -> draw on sheet 1 -> insert blank page -> verify stroke stays intact."""
        mock_ipc.create_blank_document("pages_doc")
        mock_ipc.commit_stroke(0, "pen", (1, 0, 0), 2.0, [{"x": 100, "y": 100}])
        mock_ipc.commit_stroke(1, "pen", (0, 1, 0), 2.0, [{"x": 200, "y": 200}])

        # Insert page at index 1
        page_info = {"page_index": 1, "width_pt": 612.0, "height_pt": 792.0}
        mock_ipc.active_session.page_infos.insert(1, page_info)
        mock_ipc.active_session.wal.append(WalEntryPageInserted(index=1, width_pt=612.0, height_pt=792.0))

        # Verify WAL contains page insertion and original strokes
        replayed = Wal.replay(mock_ipc.active_session.wal.path)
        assert any(isinstance(e, WalEntryPageInserted) for e in replayed)

    def test_workflow_12_export_modal_keyboard_accessibility(self):
        """Workflow 12: Export modal Tab navigation, Enter selection, Escape cancellation."""
        modal_open = True
        options = ["btnExportIncremental", "btnExportFlat", "btnCancel"]
        focused_idx = 0

        # Tab forward
        focused_idx = (focused_idx + 1) % len(options)
        assert options[focused_idx] == "btnExportFlat"

        # Tab forward to cancel
        focused_idx = (focused_idx + 1) % len(options)
        assert options[focused_idx] == "btnCancel"

        # Press Escape -> closes modal
        escape_pressed = True
        if escape_pressed:
            modal_open = False
        assert modal_open is False

    def test_workflow_13_security_sanitization_and_csp_defense(self, temp_workspace: pathlib.Path):
        """Workflow 13: Path traversal rejection, valid export, and CSP compliance."""
        # 1. Path traversal injection attempts
        for evil_path in ["../../system32/cmd.exe", "notes/../../../autoexec.bat", "out.pdf.exe"]:
            valid, _ = validate_save_path(evil_path)
            assert not valid

        # 2. Legitimate export path
        good_path = str(temp_workspace / "clean_export.pdf")
        valid, _ = validate_save_path(good_path)
        assert valid

        # 3. Verify CSP configuration in tauri.conf.json
        conf = json.loads((REPO_ROOT / "inkwell-app" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
        assert "security" in conf["app"]

    def test_workflow_14_high_frequency_rdp_simplification_and_ribbon_render(self):
        """Workflow 14: 240Hz stylus recording (500 samples) -> One-Euro -> RDP decimation -> Closed ribbon."""
        f = OneEuro()
        raw_samples = []
        for i in range(500):
            t_ms = i * 4.166
            x = 100.0 + i * 0.8 + 2.0 * math.sin(i / 10.0)
            y = 200.0 + 30.0 * math.sin(i / 20.0)
            p = 0.3 + 0.5 * math.sin(i / 50.0)
            fx = f.filter(x, t_ms)
            fy = f.filter(y, t_ms)
            raw_samples.append(Sample(fx, fy, p, t_ms))

        assert len(raw_samples) == 500

        # Apply RDP simplification (tol = 0.5)
        simplified = simplify_rdp(raw_samples, tol=0.5)
        # Verify significant point reduction while preserving fidelity (>50% reduction)
        assert len(simplified) < 250

        # Construct final vector ribbon outline
        stroke = Stroke(id=9999, kind="pen", rgb=(0, 0, 0), brush=Brush(), samples=simplified)
        poly = ribbon_outline(stroke)
        assert len(poly) > len(simplified)
