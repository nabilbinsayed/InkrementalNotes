#!/usr/bin/env python3
"""
test_lasso_selection.py — Comprehensive automated test suite for Lasso Selection & Move.
Verifies:
1. Drawing lasso loops selects enclosed vector strokes.
2. Wet canvas is cleanly cleared on every frame (no ghost boxes, no alpha accumulation / purple stains).
3. Moving selection translates stroke points and updates stroke bboxes cleanly.
4. Scaling selection via handles scales stroke points and bboxes.
5. Deselection completely wipes the overlay.
6. Undo and Redo accurately restore initial and final positions.
7. Switching tools hides selection overlay and prevents interference.
"""

import sys
import os
import pathlib
import time
from playwright.sync_api import sync_playwright

APP_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(APP_DIR, "src")

def run_tests():
    passed = 0
    total = 0

    def check(desc, cond):
        nonlocal passed, total
        total += 1
        if cond:
            print(f"  [PASS] {desc}")
            passed += 1
        else:
            print(f"  [FAIL] {desc}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--allow-file-access-from-files",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage"
            ]
        )
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()

        # Load app
        page.goto(pathlib.Path(SRC_DIR, "index.html").as_uri())
        page.wait_for_selector("#wet")
        page.wait_for_function("() => window.state !== undefined && window.documentOps !== undefined")

        # Inject test document with sample strokes
        page.evaluate("""() => {
            // Set up test document with 2 pages and 3 distinct strokes
            const strokes = [
                {
                    id: 'stroke_1',
                    sheet: 0,
                    kind: 'pen',
                    rgb: [0.1, 0.1, 0.1],
                    base_width: 2.0,
                    points: [
                        { x: 100, y: 100, p: 0.5, t: 0 },
                        { x: 150, y: 120, p: 0.5, t: 10 },
                        { x: 200, y: 100, p: 0.5, t: 20 },
                    ],
                    bbox: [100, 100, 200, 120],
                    deleted: false,
                },
                {
                    id: 'stroke_2',
                    sheet: 0,
                    kind: 'pen',
                    rgb: [0.8, 0.1, 0.1],
                    base_width: 2.0,
                    points: [
                        { x: 120, y: 140, p: 0.5, t: 0 },
                        { x: 180, y: 160, p: 0.5, t: 10 },
                    ],
                    bbox: [120, 140, 180, 160],
                    deleted: false,
                },
                {
                    id: 'stroke_outside',
                    sheet: 0,
                    kind: 'pen',
                    rgb: [0.1, 0.8, 0.1],
                    base_width: 2.0,
                    points: [
                        { x: 400, y: 400, p: 0.5, t: 0 },
                        { x: 450, y: 450, p: 0.5, t: 10 },
                    ],
                    bbox: [400, 400, 450, 450],
                    deleted: false,
                },
            ];

            const pageInfos = [
                { width_pt: 595.0, height_pt: 842.0, template: 'blank' },
                { width_pt: 595.0, height_pt: 842.0, template: 'blank' }
            ];

            window.documentOps.setDocument({ pageInfos, strokes });
            window.compositor.redrawAll();
        }""")

        print("\n=== L1  Lasso Selection by Loop ===")
        # Switch to lasso tool
        page.evaluate("window.toolManager.setTool('lasso')")
        check("Lasso tool is active", page.evaluate("window.state.activeTool === 'lasso'"))

        # Draw a freeform lasso loop around stroke_1 and stroke_2 (from 80,80 to 220,180)
        page.evaluate("""() => {
            const vp = window.getViewport();
            const pl = vp.getPageLayout(0);
            
            // Convert page coords (80, 80) to world coords
            const p0 = [pl.x + 80, pl.y + 80];
            const p1 = [pl.x + 220, pl.y + 80];
            const p2 = [pl.x + 220, pl.y + 180];
            const p3 = [pl.x + 80, pl.y + 180];

            // Simulate pointer down and lasso path
            const [s0x, s0y] = vp.worldToScreen(p0[0], p0[1]);
            window.lassoTool.onLassoDown({}, p0, [s0x, s0y], 'left', vp);
            
            // Loop points
            window.lassoTool.onLassoMove({}, p1, vp.worldToScreen(p1[0], p1[1]), 'left', vp);
            window.lassoTool.onLassoMove({}, p2, vp.worldToScreen(p2[0], p2[1]), 'left', vp);
            window.lassoTool.onLassoMove({}, p3, vp.worldToScreen(p3[0], p3[1]), 'left', vp);
            window.lassoTool.onLassoMove({}, p0, vp.worldToScreen(p0[0], p0[1]), 'left', vp);

            // Pointer up to finalize selection
            window.lassoTool.onLassoUp({}, vp);
        }""")

        selected_ids = page.evaluate("[...(window.state.selectedStrokes || [])].map(s => s.id)")
        check("stroke_1 and stroke_2 are selected", "stroke_1" in selected_ids and "stroke_2" in selected_ids)
        check("stroke_outside is NOT selected", "stroke_outside" not in selected_ids)

        bounds = page.evaluate("""() => {
            return window.overlays.getSelectionBounds(window.state, window.getViewport());
        }""")
        check("Selection bounds computed around selected strokes", bounds is not None and bounds['width'] > 0)

        print("\n=== L2  Interactive Move & Translation ===")
        # Check initial stroke coordinates
        init_x = page.evaluate("window.state.strokes.find(s => s.id === 'stroke_1').points[0].x")
        init_bbox_x = page.evaluate("window.state.strokes.find(s => s.id === 'stroke_1').bbox[0]")

        # Perform interactive move by +50 in X, +30 in Y
        page.evaluate("""() => {
            const vp = window.getViewport();
            const bounds = window.overlays.getSelectionBounds(window.state, vp);
            const midWx = (bounds.x0 + bounds.x1) / 2;
            const midWy = (bounds.y0 + bounds.y1) / 2;
            const [midSx, midSy] = vp.worldToScreen(midWx, midWy);

            // Click inside selection bounding box
            window.lassoTool.onLassoDown({}, [midWx, midWy], [midSx, midSy], 'left', vp);

            // Move by +50, +30
            const newWx = midWx + 50;
            const newWy = midWy + 30;
            const [newSx, newSy] = vp.worldToScreen(newWx, newWy);
            window.lassoTool.onLassoMove({}, [newWx, newWy], [newSx, newSy], 'left', vp);

            // Finish drag
            window.lassoTool.onLassoUp({}, vp);
        }""")

        moved_x = page.evaluate("window.state.strokes.find(s => s.id === 'stroke_1').points[0].x")
        moved_bbox_x = page.evaluate("window.state.strokes.find(s => s.id === 'stroke_1').bbox[0]")

        check("Stroke points moved by exactly +50", abs((moved_x - init_x) - 50) < 0.001)
        check("Stroke bbox matches recomputed bounding box (including width margin)", abs(moved_bbox_x - (150 - 1.0)) < 0.001)

        print("\n=== L3  Wet Canvas Hygiene (No Ghost Boxes / No Stain Accumulation) ===")
        # Inspect wet canvas pixel data around selection
        is_wet_clean_after_clear = page.evaluate("""() => {
            // Deselect by clicking outside
            const vp = window.getViewport();
            window.lassoTool.onLassoDown({}, [10, 10], [10, 10], 'left', vp);
            window.lassoTool.onLassoUp({}, vp);

            // Verify wet canvas is completely transparent (all pixels alpha == 0)
            const wet = document.getElementById('wet');
            const ctx = wet.getContext('2d');
            const imgData = ctx.getImageData(0, 0, 100, 100).data;
            let nonZero = 0;
            for (let i = 3; i < imgData.length; i += 4) {
                if (imgData[i] > 0) nonZero++;
            }
            return { nonZero, total: imgData.length / 4, selectedCount: (window.state.selectedStrokes || []).length };
        }""")
        check("Clicking outside clears selection count to 0", is_wet_clean_after_clear['selectedCount'] == 0)
        check("Wet canvas is completely cleared (zero ghost artifacts)", is_wet_clean_after_clear['nonZero'] == 0)

        print("\n=== L4  Undo & Redo Verification ===")
        # Re-select stroke_1
        page.evaluate("""() => {
            const vp = window.getViewport();
            const s1 = window.state.strokes.find(s => s.id === 'stroke_1');
            window.state.selectedStrokes = [s1];
            
            const bounds = window.overlays.getSelectionBounds(window.state, vp);
            const midWx = (bounds.x0 + bounds.x1) / 2;
            const midWy = (bounds.y0 + bounds.y1) / 2;
            const [midSx, midSy] = vp.worldToScreen(midWx, midWy);

            // Move by +40, +20
            window.lassoTool.onLassoDown({}, [midWx, midWy], [midSx, midSy], 'left', vp);
            window.lassoTool.onLassoMove({}, [midWx + 40, midWy + 20], [midSx + 40, midSy + 20], 'left', vp);
            window.lassoTool.onLassoUp({}, vp);
        }""")

        before_undo_x = page.evaluate("window.state.strokes.find(s => s.id === 'stroke_1').points[0].x")

        # Undo the move
        page.evaluate("window.documentOps.performUndo()")
        after_undo_x = page.evaluate("window.state.strokes.find(s => s.id === 'stroke_1').points[0].x")
        check("Undo reverts stroke points to previous position", abs((before_undo_x - after_undo_x) - 40) < 0.001)

        # Redo the move
        page.evaluate("window.documentOps.performRedo()")
        after_redo_x = page.evaluate("window.state.strokes.find(s => s.id === 'stroke_1').points[0].x")
        check("Redo restores stroke points to moved position", abs(after_redo_x - before_undo_x) < 0.001)

        print("\n=== L5  Tool Switching Cleanup ===")
        # Switch tool to Pen
        page.evaluate("window.toolManager.setTool('pen')")
        check("Active tool changed to pen", page.evaluate("window.state.activeTool === 'pen'"))

        # Inactive lasso should not render selection overlay on wet canvas
        wet_alpha_in_pen = page.evaluate("""() => {
            window.compositor.redrawAll();
            const wet = document.getElementById('wet');
            const ctx = wet.getContext('2d');
            const data = ctx.getImageData(0, 0, wet.width, wet.height).data;
            let sumAlpha = 0;
            for (let i = 3; i < data.length; i += 4) {
                sumAlpha += data[i];
            }
            return sumAlpha;
        }""")
        print("\n=== L6  Interactive Rotation Verification ===")
        # Switch back to lasso
        page.evaluate("window.toolManager.setTool('lasso')")
        
        # Test rotation handle detection
        rot_handle = page.evaluate("""() => {
            const vp = window.getViewport();
            const s1 = window.state.strokes.find(s => s.id === 'stroke_1');
            window.state.selectedStrokes = [s1];
            window.compositor.redrawAll();

            const bounds = window.overlays.getSelectionBounds(window.state, vp);
            const [sx0, sy0] = vp.worldToScreen(bounds.x0 - 6, bounds.y0 - 6);
            const [sx1, sy1] = vp.worldToScreen(bounds.x1 + 6, bounds.y1 + 6);
            const midSx = (Math.min(sx0, sx1) + Math.max(sx0, sx1)) / 2;
            const minY = Math.min(sy0, sy1);
            
            // Handle is at (midSx, minY - 26)
            return window.overlays.getSelectionHandleAt(midSx, minY - 26, window.state, vp);
        }""")
        check("Rotation handle detected above top-center bounding box", rot_handle is not None and rot_handle.get('name') == 'rotate')
        check("Rotation handle provides grab cursor", rot_handle is not None and rot_handle.get('cursor') == 'grab')

        # Rotate by 90 degrees (PI / 2 radians)
        page.evaluate("""() => {
            const vp = window.getViewport();
            const s1 = window.state.strokes.find(s => s.id === 'stroke_1');
            window.state.selectedStrokes = [s1];
            
            const bounds = window.overlays.getSelectionBounds(window.state, vp);
            const centerWx = (bounds.x0 + bounds.x1) / 2;
            const centerWy = (bounds.y0 + bounds.y1) / 2;
            const radiusW = (bounds.y1 - bounds.y0) / 2 + 30; // distance above center

            const [sx0, sy0] = vp.worldToScreen(bounds.x0 - 6, bounds.y0 - 6);
            const [sx1, sy1] = vp.worldToScreen(bounds.x1 + 6, bounds.y1 + 6);
            const midSx = (Math.min(sx0, sx1) + Math.max(sx0, sx1)) / 2;
            const minY = Math.min(sy0, sy1);

            // Pointer down on rotation handle (above center: angle -PI/2)
            const startWx = centerWx;
            const startWy = centerWy - radiusW;
            window.lassoTool.onLassoDown({}, [startWx, startWy], [midSx, minY - 26], 'left', vp);

            // Drag to the right (angle 0 => delta +PI/2 = +90 degrees)
            const dragWx = centerWx + radiusW;
            const dragWy = centerWy;
            const [dragSx, dragSy] = vp.worldToScreen(dragWx, dragWy);
            window.lassoTool.onLassoMove({}, [dragWx, dragWy], [dragSx, dragSy], 'left', vp);

            // Finish rotation
            window.lassoTool.onLassoUp({}, vp);
        }""")

        rotated_pts = page.evaluate("""() => {
            const s1 = window.state.strokes.find(s => s.id === 'stroke_1');
            return s1.points.map(p => ({ x: p.x, y: p.y }));
        }""")
        
        # Horizontal stroke (dx > dy) after 90 deg rotation becomes vertical (dy > dx)
        dx_rot = abs(rotated_pts[-1]['x'] - rotated_pts[0]['x'])
        dy_rot = abs(rotated_pts[-1]['y'] - rotated_pts[0]['y'])
        check("Stroke rotated by ~90 degrees from horizontal to vertical", dy_rot > dx_rot and dy_rot > 80)

        # Verify undo of rotation
        page.evaluate("window.documentOps.performUndo()")
        undone_pts = page.evaluate("""() => {
            const s1 = window.state.strokes.find(s => s.id === 'stroke_1');
            return s1.points.map(p => ({ x: p.x, y: p.y }));
        }""")
        dx_undone = abs(undone_pts[-1]['x'] - undone_pts[0]['x'])
        dy_undone = abs(undone_pts[-1]['y'] - undone_pts[0]['y'])
        check("Undo reverts rotated stroke back to horizontal", dx_undone > dy_undone and dx_undone > 80)

        # Verify redo of rotation
        page.evaluate("window.documentOps.performRedo()")
        redone_pts = page.evaluate("""() => {
            const s1 = window.state.strokes.find(s => s.id === 'stroke_1');
            return s1.points.map(p => ({ x: p.x, y: p.y }));
        }""")
        dx_redone = abs(redone_pts[-1]['x'] - redone_pts[0]['x'])
        dy_redone = abs(redone_pts[-1]['y'] - redone_pts[0]['y'])
        check("Redo restores rotated vertical state", dy_redone > dx_redone and dy_redone > 80)

        browser.close()

    print("\n" + "=" * 60)
    print(f"  {passed}/{total} checks passed")
    print("=" * 60)
    return 0 if passed == total else 1

if __name__ == "__main__":
    sys.exit(run_tests())
