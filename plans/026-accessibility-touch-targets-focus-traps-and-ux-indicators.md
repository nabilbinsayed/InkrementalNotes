# Plan 026: Accessibility Hardening: 44px Touch Targets, Modal Focus Traps, and State Indicators

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1154947..HEAD -- inkwell-app/src/styles.css inkwell-app/src/index.html inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `1154947`, 2026-08-14

## Why this matters

The UI/UX audit identified several accessibility and user experience gaps:
1. Multiple interactive buttons (tab close, outline toggles, mini nav buttons, zoom dock) have hit targets under 30px (some as small as 18px), violating WCAG 2.5.5 touch target standards.
2. Selection transform handles have only an 8px hit radius.
3. Modals (`#exportModal`) lack keyboard focus traps, initial focus, and Escape key dismissal.
4. Large PDF loading has no progress overlay, making the app appear frozen.
5. Undo and Redo toolbar buttons lack disabled state styling.

## Current state

- `inkwell-app/src/styles.css:927, 2620, 1104, 1445` — Touch targets between 18px and 30px.
- `inkwell-app/src/js/app.js:890` — Handle hit radius hardcoded to `8px`.
- `inkwell-app/src/index.html:624` & `inkwell-app/src/js/app.js:3780` — `#exportModal` lacks Escape handler and focus trap.
- `inkwell-app/src/js/app.js:3515` — `open_pdf` does not display a loading spinner during import.
- `inkwell-app/src/js/app.js:2243` — `undo()` and `redo()` do not update `disabled` state on `#btnUndo` / `#btnRedo`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |

## Scope

**In scope**:
- `inkwell-app/src/styles.css`
- `inkwell-app/src/index.html`
- `inkwell-app/src/js/app.js`

## Git workflow

- Branch: `advisor/026-accessibility-and-ux-polish`
- Commit per step; message style: `feat(a11y): <description>`

## Steps

### Step 1: Expand touch targets to >= 44x44px and expand selection handles

1. In `inkwell-app/src/styles.css`:
   - Add a touch expansion rule for compact icon buttons:
   ```css
   .tab-close, .outline-toggle, .nav-cluster-btn.mini, .bookmark-delete-btn, .zoom-dock-btn, .drawer-close-btn {
     position: relative;
   }
   .tab-close::after, .outline-toggle::after, .nav-cluster-btn.mini::after, .bookmark-delete-btn::after, .zoom-dock-btn::after, .drawer-close-btn::after {
     content: '';
     position: absolute;
     inset: -10px;
     min-width: 44px;
     min-height: 44px;
   }
   ```
2. In `inkwell-app/src/js/app.js` in `getSelectionHandleAt()`:
   - Expand selection handle hit testing: `Math.hypot(screenX - h.x, screenY - h.y) <= (e.pointerType === 'touch' ? 22 : 14)`.

**Verify**: Test clicking/tapping small icons: hit detection is reliable across stylus, touch, and mouse.

### Step 2: Implement Modal Focus Trap, Escape Dismissal, and Export Keyboard Activation

In `inkwell-app/src/js/app.js`:
1. In global `keydown` listener:
   - When Escape is pressed and `!$('exportModal').classList.contains('hidden')`, invoke `closeExportModal()`.
2. When opening `#exportModal`:
   - Focus `#btnExportIncremental` automatically.
   - Trap Tab focus between export modal interactive cards and the close button.
3. Attach `keydown` listeners on `.export-option-card` elements to trigger export on `Enter` or `Space`.

**Verify**: Open Export modal, navigate using Tab, press Enter on an option card, or press Escape: modal responds to all standard keyboard patterns.

### Step 3: Add Loading Progress Overlay and Undo/Redo Disabled States

1. In `inkwell-app/src/js/app.js`:
   - In `triggerOpen()` / file drop handlers, display `showSaveProgress(true, 'Opening and indexing PDF...')` before initiating IPC, and dismiss it in `handlePdfLoadSuccess()` and `catch` blocks.
   - Implement `updateUndoRedoUI()`:
     ```javascript
     function updateUndoRedoUI() {
       const btnUndo = $('btnUndo'), btnRedo = $('btnRedo');
       if (btnUndo) btnUndo.disabled = (state.undoStack.length === 0);
       if (btnRedo) btnRedo.disabled = (state.redoStack.length === 0);
     }
     ```
   - Call `updateUndoRedoUI()` whenever `undoStack` or `redoStack` is mutated.
2. In `inkwell-app/src/styles.css`:
   - Add `.toolbar-btn:disabled { opacity: 0.35; pointer-events: none; }` and adjust toast positioning so `.toast-container` does not overlap `#zoomControl`.

**Verify**: Run `cd inkwell-m0; py -3 test_smoke.py` → 18/18 checks pass.

## Test plan

- Test keyboard navigation across all dialogs and modals using Tab, Enter, Space, and Escape.
- Test opening a multi-megabyte PDF: loading progress indicator appears immediately and dismisses when complete.
- Test undo/redo button states: disabled on clean document, enabled when strokes are drawn, disabled when stack is empty.

## Done criteria

- [ ] All interactive buttons satisfy >= 44x44px touch targets
- [ ] Export modal handles Escape and traps focus
- [ ] Large PDF imports display loading overlay
- [ ] Undo and Redo buttons reflect stack state
- [ ] `cd inkwell-m0; py -3 test_smoke.py` exits 0

## Maintenance notes

- Any newly added interactive modal must implement standard ARIA roles, initial focus, focus trapping, and Escape key dismissal.
