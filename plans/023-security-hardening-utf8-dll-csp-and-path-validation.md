# Plan 023: Security Hardening: UTF-8 Search Slicing, DLL Hijacking Prevention, CSP, and Input Validation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1154947..HEAD -- inkwell-app/src-tauri/src/commands.rs inkwell/crates/inkwell-pdf/src/lib.rs inkwell/crates/inkwell-core/src/codec.rs inkwell/crates/inkwell-core/src/pdfobj.rs inkwell-app/src-tauri/tauri.conf.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `1154947`, 2026-08-14

## Why this matters

The audit discovered several security and stability vulnerabilities:
1. `search_pdf` calculates byte slices on `text` using offsets found in `text.to_lowercase()`, which panics when searching non-ASCII or multi-byte UTF-8 Unicode characters.
2. `init_pdfium` inspects `std::env::current_dir()` and relative `./` paths, enabling DLL hijacking if the user opens a file from untrusted folders.
3. Unbounded vector capacity allocations in `codec.rs` and unvalidated token boundaries in `pdfobj.rs` allow malformed files to trigger OOM aborts or out-of-bounds slicing.
4. Absence of Content Security Policy (CSP) and unvalidated `save_pdf` paths expose IPC surfaces to potential traversal and injection risks.

## Current state

- `inkwell-app/src-tauri/src/commands.rs:770-777` — Slices `text[start..end]` using byte offsets derived from lowercased text.
- `inkwell/crates/inkwell-pdf/src/lib.rs:37-46, 65-66` — Searches current working directory for `pdfium.dll`.
- `inkwell/crates/inkwell-core/src/codec.rs:156-181` — `Vec::with_capacity(count)` allocates directly from payload varint.
- `inkwell/crates/inkwell-core/src/pdfobj.rs:113-126` — `skip_value` returns `j + 1` which can exceed `d.len()`.
- `inkwell-app/src-tauri/tauri.conf.json:24` — `"csp": null`.
- `inkwell-app/src-tauri/src/commands.rs:535-550` — `save_pdf` does not validate path traversal components in `out_path_str`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Core Tests | `cd inkwell; cargo test -- --test-threads=1` | exit 0, all 48 tests pass |
| Clippy | `cd inkwell-app/src-tauri; cargo clippy --all-targets` | exit 0, zero warnings |
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell/crates/inkwell-pdf/src/lib.rs`
- `inkwell/crates/inkwell-core/src/codec.rs`
- `inkwell/crates/inkwell-core/src/pdfobj.rs`
- `inkwell-app/src-tauri/tauri.conf.json`

## Git workflow

- Branch: `advisor/023-security-hardening`
- Commit per step; message style: `fix(security): <description>`

## Steps

### Step 1: Fix UTF-8 character boundary slicing in `search_pdf`

In `inkwell-app/src-tauri/src/commands.rs`:
1. In `search_pdf` (lines 767–784), avoid slicing raw bytes on `text`.
2. Instead, use character iterators or find character boundaries:
   ```rust
   let chars: Vec<char> = text.chars().collect();
   let char_text_lower: String = chars.iter().collect::<String>().to_lowercase();
   if let Some(char_idx) = char_text_lower.find(&q_lower) {
       // Convert string char_idx to character slice window safely
       let char_pos = char_text_lower[..char_idx].chars().count();
       let start = char_pos.saturating_sub(40);
       let end = (char_pos + query_trimmed.chars().count() + 40).min(chars.len());
       let snippet = format!(
           "{}{}{}",
           if start > 0 { "…" } else { "" },
           chars[start..end].iter().collect::<String>().replace('\n', " "),
           if end < chars.len() { "…" } else { "" }
       );
       // ...
   }
   ```

**Verify**: Add a unit test searching Unicode/non-ASCII text in `tests/integration.rs` → passes cleanly.

### Step 2: Restrict PDFium DLL search path to executable directory and system folders

In `inkwell/crates/inkwell-pdf/src/lib.rs`:
1. In `init_pdfium()`, remove `std::env::current_dir()` search and relative `./` / `../` fallbacks.
2. Restrict lookup to:
   - Directory containing the running executable (`std::env::current_exe()?.parent()`)
   - `std::env::var("PDFIUM_DLL_DIR")` (if explicitly configured by operator)
   - Standard system library path (`Pdfium::bind_to_system_library()`)

**Verify**: Run `cd inkwell; cargo test -- --test-threads=1` → all 48 tests pass.

### Step 3: Bound vector allocations and clamp token indices

1. In `inkwell/crates/inkwell-core/src/codec.rs`:
   - Bound initial `with_capacity` allocations: `Vec::with_capacity((count as usize).min(1024))`.
   - In `get_uvarint`, return `None` if `shift >= 64` or `shift == 63 && (b & 0x7F) > 1`.
2. In `inkwell/crates/inkwell-core/src/pdfobj.rs`:
   - In `skip_value`, ensure returned end offsets are clamped to `d.len()`.
   - In dictionary parsing, check `j < d.len()` before evaluating escape characters.

**Verify**: Run `cd inkwell; cargo test -- --test-threads=1` → all 48 tests pass.

### Step 4: Configure CSP and sanitize file save paths

1. In `inkwell-app/src-tauri/tauri.conf.json`:
   - Set `"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'ipc:';"`
2. In `inkwell-app/src-tauri/src/commands.rs`:
   - In `save_pdf`, validate that `out_path_str` (if provided) is a clean canonical path without relative traversal segments (`..`), ends with `.pdf` (case-insensitive), and has a valid parent directory.
   - In `insert_blank_page` and `create_blank_document`, assert dimensions are finite and bounded between `72.0` and `14400.0` points.

**Verify**: Run `cd inkwell-app/src-tauri; cargo clippy --all-targets` → zero warnings.

## Test plan

- Test searching Unicode text (e.g. Bangla text from `Higher_Math_Bangla_chapter_3.pdf`, mathematical symbols, emojis): search must return matching snippets without process panics.
- Test loading malformed or truncated varint buffers in `codec.rs`: decoding must return graceful error results without panicking or allocating gigabytes.
- Test `save_pdf` with path traversal input (e.g. `../../test.pdf`): path must be rejected or cleanly normalized.

## Done criteria

- [ ] Searching Unicode/non-ASCII text never panics on string slicing
- [ ] `pdfium.dll` search ignores `current_dir()`
- [ ] `codec.rs` varint decoders guard against integer overflow and unbounded pre-allocation
- [ ] Restrictive CSP configured in `tauri.conf.json`
- [ ] `cd inkwell; cargo test -- --test-threads=1` exits 0

## STOP conditions

- If CSP blocks local canvas blob generation or font rendering, adjust CSP directives to include required local schemes.

## Maintenance notes

- Any future string slicing on external PDF text or user input must always use character-based indices (`char_indices()` / `.chars()`) instead of raw byte slicing.
