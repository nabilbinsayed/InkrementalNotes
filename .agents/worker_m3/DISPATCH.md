## 2026-09-02T11:45:03Z

You are worker_m3, assigned to execute Milestone 3: Comprehensive Verification & Smoke Suite Expansion for InkWell.

Your working directory is: /mnt/Work/Own Programs/InkWell/.agents/worker_m3/
Your scope document is: /mnt/Work/Own Programs/InkWell/PROJECT.md
Authoritative user request: /mnt/Work/Own Programs/InkWell/.agents/ORIGINAL_REQUEST.md
Guidelines and non-negotiables: /mnt/Work/Own Programs/InkWell/AGENTS.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Tasks:
1. Read /mnt/Work/Own Programs/InkWell/.agents/ORIGINAL_REQUEST.md, /mnt/Work/Own Programs/InkWell/PROJECT.md, and /mnt/Work/Own Programs/InkWell/AGENTS.md.
2. Update `/mnt/Work/Own Programs/InkWell/inkwell-app/test_app_smoke.py` to consolidate all interaction and ergonomics verification into the primary smoke test suite:
   - T1: Boot & ES Module Loading (triple canvas, stage, Tauri stub)
   - T2: Tool Switching & State Machine (9 dock tools + tool history tracking)
   - T3: Spacebar Quick-Toggle & Hold-to-Pan:
     * Quick tap (<250ms) toggles between current tool and last active tool
     * Holding Space (>=250ms) temporarily activates pan mode, and releasing reverts to previous tool
     * Left-click dragging canvas in Pan mode updates viewport pan coordinates
   - T4: PDF Text Selection, Highlights & Clipboard:
     * Canvas drag selection creates selection range and rects
     * Selection popover appears with Copy button
     * Ctrl+C / Clipboard copy copies the selected text accurately
     * Multi-line character indexing is respected
   - T5: Canvas Context Menu & Tool Triggering:
     * Right-click on canvas opens context menu with Copy, Cut, Paste, Undo, Redo items
     * Context menu items function correctly
   - T6: Radial Tool Menu:
     * Query selector `.radial-item` switches tools accurately
   - T7: Command Palette:
     * Modal opening, keyboard navigation (ArrowDown/Enter), and Escape dismissal
   - T8: Touch Target & Accessibility Ergonomics (F13-F15):
     * Compact buttons (`.header-icon-btn`, `.nav-cluster-btn`, `.zoom-dock-btn`, `.tab-add-btn`, `.tab-close`) expand to >= 44x44px via `::before` pseudo-element hit areas
     * Universal `:focus-visible` high-contrast outline rules
     * Glassmorphic toast notifications with ARIA attributes (`aria-live="polite"`, `role="status"`, `role="alert"`)
   - T9: Navigation Rail & Drawer Panels (Thumbnails, Outline, Search, DocInfo)
   - T10: Synthetic Pen Input Pipeline (CDP mouse/pen input dispatched to wet canvas, committed to document state, composited on dry canvas)
   - T11: Zoom Controls & Percentage Readout
   - T12: Console Hygiene (0 console errors, 0 internal inkwell warnings)
3. Run and verify all required test commands:
   - `cd "/mnt/Work/Own Programs/InkWell/inkwell" && cargo test --workspace -- --test-threads=1` (All 72 tests pass, 0 panics)
   - `cd "/mnt/Work/Own Programs/InkWell/inkwell-app" && uv run --with playwright python3 test_app_smoke.py` (All checks pass with exit 0)
   - `cd "/mnt/Work/Own Programs/InkWell/inkwell" && cargo check --all-targets` (0 warnings, 0 errors)
4. Document all results and write a complete handoff report to `/mnt/Work/Own Programs/InkWell/.agents/worker_m3/handoff.md` with:
   - Observation (Baseline state & consolidated test suite)
   - Logic Chain
   - Caveats
   - Conclusion
   - Verification Method with exact commands and output summaries
5. Send a completion message back to the orchestrator.
