## 2026-09-02T11:56:11Z

Remediation Tasks:
1. Fix Bug 1 (`toolbar.closeZoomMenu` TypeError):
   - In `inkwell-app/src/js/ui/toolbar.js`, export `closeZoomMenu` function that closes `#zoomMenuPopover` (e.g. `export function closeZoomMenu() { const el = document.getElementById('zoomMenuPopover'); if (el) el.classList.add('hidden'); }`).
   - In `inkwell-app/src/js/main.js`, ensure `applyCustomZoom` closes the zoom menu cleanly without throwing any TypeError.
2. Fix Bug 2 (`expandSelectionToWord` line boundary bleeding):
   - In `inkwell-app/src/js/workspace/text-selection.js` in `expandSelectionToWord(sheet, charIdx)`:
     Extract the `line_index` of the character at `charIdx`: `const initialLine = pageData.chars[charIdx].line_index;`.
     Constrain the expansion while loops so they require `char.line_index === initialLine`:
     ```javascript
     while (start > 0 && pageData.chars[start - 1].line_index === initialLine && isWordChar(pageData.chars[start - 1].c)) {
       start--;
     }
     while (end < pageData.chars.length - 1 && pageData.chars[end + 1].line_index === initialLine && isWordChar(pageData.chars[end + 1].c)) {
       end++;
     }
     ```
3. Expand `inkwell-app/test_app_smoke.py`:
   - In `T11 Zoom Controls & Percentage Readout`: add test steps to click `#btnZoomMenu`, fill `#inputCustomZoom` with `'120'`, click `#btnApplyCustomZoom`, and verify zoom updates and zero page errors occur.
   - In `T4 PDF Text Selection, Highlights & Clipboard`: add test verification for `expandSelectionToWord` on multi-line text ensuring characters from adjacent lines are not selected.
4. Run full verification commands:
   - `cd "/mnt/Work/Own Programs/InkWell/inkwell-app" && uv run --with playwright python3 test_app_smoke.py`
   - `cd "/mnt/Work/Own Programs/InkWell/inkwell-app" && uv run --with playwright python3 test_adversarial_m3.py` (ensure challenger suite passes)
   - `cd "/mnt/Work/Own Programs/InkWell/inkwell" && cargo test --workspace -- --test-threads=1`
   - `cd "/mnt/Work/Own Programs/InkWell/inkwell" && cargo check --all-targets`
5. Write handoff report to `/mnt/Work/Own Programs/InkWell/.agents/worker_m3_iter2/handoff.md` and send completion message.
