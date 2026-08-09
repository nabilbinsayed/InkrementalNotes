# Plan 015: UI/UX Pro-Max Touch Targets, Focus Rings, Tool Cursors, & Glassmorphic Toasts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat db1c3a4..HEAD -- inkwell-app/src/index.html inkwell-app/src/styles.css inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: ui-ux-pro-max
- **Planned at**: commit `db1c3a4`, 2026-08-09

## Why this matters

The floating toolbar and property popover controls currently measure 30-34px, failing WCAG 2.5.5 touch target size standards (44x44px minimum for digitizer pens and touch input). The canvas displays the default arrow cursor regardless of active tool, native `alert()` dialogs block JS execution and clash with the dark theme, and interactive buttons lack focus outlines and ARIA labels.

Following rules from `/ui-ux-pro-max` (OLED Dark Mode palette `#1C1917`, `#7C3AED` primary, `#0891B2` accent), this plan increases touch target sizes to 44px min, adds tool-specific canvas cursors, implements non-blocking glassmorphic toast notifications, and adds accessible ARIA attributes.

## Current state

- `inkwell-app/src/styles.css:98,148,263`: Toolbar buttons are sized 30-34px without focus rings or active swatch feedback.
- `inkwell-app/src/js/app.js:1249,1262`: Native browser `alert()` dialogs block thread execution on load/save errors.
- `inkwell-app/src/index.html:15-76`: Icon buttons use raw unicode/emojis without `aria-label` attributes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Playwright smoke test | `cd inkwell-m0 && py -3 test_smoke.py` | exit 0, 18/18 pass |

## Scope

**In scope**:
- `inkwell-app/src/index.html`
- `inkwell-app/src/styles.css`
- `inkwell-app/src/js/app.js`

**Out of scope**:
- Rust backend files

## Steps

### Step 1: Enforce 44px touch targets and visible focus-visible rings in CSS

In `inkwell-app/src/styles.css`:
1. Increase button touch padding and minimum dimensions on `.tool-btn`, `.nav-btn`, and `.swatch` to guarantee 44x44px target areas:
   ```css
   .tool-btn {
     min-width: 44px;
     min-height: 44px;
   }
   .swatch {
     min-width: 44px;
     min-height: 44px;
   }
   ```
2. Add explicit `:focus-visible` styles for keyboard navigation compliance:
   ```css
   button:focus-visible, .tool-btn:focus-visible {
     outline: 2px solid #7C3AED;
     outline-offset: 2px;
   }
   ```
3. Add `.swatch.active` visual outline style to show current color selection.

**Verify**: Check button target sizes in devtools or smoke test.

### Step 2: Implement tool-specific canvas cursor feedback

In `inkwell-app/src/styles.css` & `inkwell-app/src/js/app.js`:
1. Define tool cursor CSS classes:
   - `#wet.tool-pen`, `#wet.tool-highlighter`: `crosshair`
   - `#wet.tool-eraser`: `circle` cursor or custom SVG eraser pointer
   - `#wet.tool-lasso`: `cell`
   - `#wet.tool-ruler`, `#wet.tool-rect`, `#wet.tool-ellipse`: `crosshair`
2. Update `setTool()` in `app.js` to toggle the active tool class on `#wet` canvas.

**Verify**: `py -3 inkwell-m0/test_smoke.py` -> exit 0.

### Step 3: Implement non-blocking Toast notification component & ARIA labels

In `inkwell-app/src/index.html` & `inkwell-app/src/js/app.js`:
1. Add `#toastContainer` element to `index.html`.
2. Add `showToast(message, type = 'info')` function in `app.js` with glassmorphic styling (`background: rgba(28, 25, 23, 0.9)`, `backdrop-filter: blur(12px)`).
3. Replace `alert()` calls in `app.js` with `showToast()`.
4. Add descriptive `aria-label` attributes to all icon buttons in `index.html`.

**Verify**: Run `cd inkwell-m0 && py -3 test_smoke.py` -> exit 0.

## Test plan

- Run Playwright smoke test to verify all toolbar buttons and tools function cleanly.
- Verification command: `cd inkwell-m0 && py -3 test_smoke.py` -> exit 0.

## Done criteria

- [ ] All `.tool-btn`, `.nav-btn`, and `.swatch` elements meet 44x44px touch target guidelines.
- [ ] `:focus-visible` outlines render on focused buttons.
- [ ] Native `alert()` calls replaced with `showToast()`.
- [ ] `plans/README.md` updated.

## STOP conditions

- If toolbar button enlargement causes layout wrapping on 1024px windows, adjust toolbar flex gap and padding accordingly.
