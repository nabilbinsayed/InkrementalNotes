## 2026-09-02T11:31:10Z

You are worker_m2, a teamwork_preview_worker.
Your working directory is /mnt/Work/Own Programs/InkWell/.agents/worker_m2.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A forensic auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Objective:
Implement Milestone 2: UI/UX & Touch Ergonomics Optimization for InkWell (F13–F15).

Input Files:
- `/mnt/Work/Own Programs/InkWell/.agents/ORIGINAL_REQUEST.md`
- `/mnt/Work/Own Programs/InkWell/AGENTS.md`
- `/mnt/Work/Own Programs/InkWell/PROJECT.md`
- `/mnt/Work/Own Programs/InkWell/.agents/explorer_survey_3/handoff.md`

File Ownership Exclusively Assigned to You:
- `inkwell-app/src/styles.css`
- `inkwell-app/src/index.html` (if any accessibility/ARIA attributes or button classes need refinement)
- `inkwell-app/src/js/ui/toast.js`

Instructions:
1. Touch Target Accessibility (F13):
   - Per AGENTS.md Rule 6, interactive elements must satisfy minimum touch target guidelines (44x44px).
   - In `styles.css`, inspect buttons that are visually compact (< 44px):
     - `.header-icon-btn` (32x32px)
     - `.nav-cluster-btn` (32x32px)
     - `.nav-cluster-btn.mini` (24x24px)
     - `.zoom-dock-btn` (30x30px)
     - `.tab-add-btn` (28x28px)
     - `.tab-close` (18x18px)
     - `.drawer-close-btn` (28x28px)
     - `.bookmark-delete-btn` (24x24px)
     - `.layer-visibility-btn` (24x24px)
   - Expand their interactive hit targets to at least 44x44px using CSS pseudo-elements (`::before` / `::after` with `position: absolute; min-width: 44px; min-height: 44px; top: 50%; left: 50%; transform: translate(-50%, -50%); content: ''; z-index: 1;`) or appropriate touch margins/padding, preserving their compact visual design while ensuring easy touch/stylus tapping.
2. Focus Rings & Toast Notifications (F14):
   - Ensure `:focus-visible` styling (`outline: 2px solid #7C3AED; outline-offset: 2px;`) applies cleanly across all buttons, tabs, inputs, and modals.
   - Verify toast notifications (`toast.js` and `styles.css`) have smooth glassmorphic styling (`backdrop-filter: blur(12px)`), high contrast text, and color-coded status borders.
3. Verification:
   - Run desktop smoke tests: `cd /mnt/Work/Own Programs/InkWell/inkwell-app && uv run --with playwright python3 test_app_smoke.py`
   - Run interactive tests: `cd /mnt/Work/Own Programs/InkWell/inkwell-app && uv run --with playwright python3 test_m1_interactive.py`
   - Run Rust tests: `cd /mnt/Work/Own Programs/InkWell/inkwell && cargo test --workspace -- --test-threads=1`
   - Ensure 0 visual regressions, 0 console errors, and 100% test pass.
4. Write handoff report to `/mnt/Work/Own Programs/InkWell/.agents/worker_m2/handoff.md` and message parent when complete.
