# Plan 039: Rust Core & Backend Compiler Warning Elimination and Cross-Platform Cleanup

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aef1b6a..HEAD -- inkwell/crates/inkwell-pdf/src/text.rs inkwell-app/src-tauri/src/stylus_linux.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `aef1b6a`, 2026-08-21

## Why this matters

The repository's strict quality rules in `AGENTS.md` mandate zero warnings for `cargo clippy --all-targets`. Currently, `inkwell-pdf` emits a `clippy::if_same_then_else` warning in `text.rs` due to duplicate branch conditions. Additionally, `inkwell-app/src-tauri/src/stylus_linux.rs` emits 17 dead-code compiler warnings on non-Linux operating systems (Windows and macOS) because Linux `evdev` structs, IOCTL constants, and enum variants are declared unconditionally without platform conditional compilation guards. Resolving these ensures clean CI builds across all supported platforms.

## Current state

- `inkwell/crates/inkwell-pdf/src/text.rs:185-189`:
  ```rust
  let starts_new_line = if current_line.is_empty() {
      false
  } else if is_newline {
      false
  } else if rc.has_bounds && line_min_y.is_finite() {
  ```
  Triggers `clippy::if_same_then_else`.
- `inkwell-app/src-tauri/src/stylus_linux.rs:25-115`:
  Structs `InputEvent`, `InputAbsInfo`, constants `EVIOCGNAME_256`, `ABS_PRESSURE`, `BTN_TOUCH`, etc., and enum variants `StylusMessage::Handshake` and `Sample` are declared at top-level without `#[cfg(target_os = "linux")]` or `#[allow(dead_code)]`, triggering compiler dead-code warnings when built on Windows or macOS.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Core Clippy | `cd inkwell; cargo clippy --all-targets` | exit 0, zero warnings |
| Backend Clippy | `cd inkwell-app/src-tauri; cargo clippy --all-targets` | exit 0, zero warnings |
| Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Backend Tests | `cd inkwell-app/src-tauri; cargo test` | exit 0, all tests pass |

## Scope

**In scope**:
- `inkwell/crates/inkwell-pdf/src/text.rs`
- `inkwell-app/src-tauri/src/stylus_linux.rs`

**Out of scope**:
- Changing the runtime logic of Linux evdev streaming or PDF text extraction.

## Git workflow

- Branch: `advisor/039-rust-clippy-cleanup`
- Commit style: `fix(core): <description>`

## Steps

### Step 1: Fix Clippy Duplicate Branch in `crates/inkwell-pdf/src/text.rs`
In `inkwell/crates/inkwell-pdf/src/text.rs:185`:
Simplify the line check condition to combine the empty line and newline checks:
```rust
let starts_new_line = if current_line.is_empty() || is_newline {
    false
} else if rc.has_bounds && line_min_y.is_finite() {
    let line_h = (line_max_y - line_min_y).max(6.0);
    let line_mid_y = (line_min_y + line_max_y) / 2.0;
    let cur_mid_y = (rc.y0 + rc.y1) / 2.0;
    let vert_diff = (cur_mid_y - line_mid_y).abs();

    vert_diff > line_h * 0.6 || (rc.x0 < line_min_x - 10.0 && vert_diff > 3.0)
} else {
    false
};
```

**Verify**: `cd inkwell; cargo clippy --all-targets` → zero warnings.

### Step 2: Add Platform Conditional Compilation Guards in `stylus_linux.rs`
In `inkwell-app/src-tauri/src/stylus_linux.rs`:
1. Annotate Linux-specific definitions (`InputEvent`, `InputAbsInfo`, IOCTL constants, and `EV_*` / `ABS_*` / `BTN_*` constants) with `#[cfg(target_os = "linux")]` or `#[allow(dead_code)]`.
2. Annotate `StylusMessage` enum variants or the entire enum with `#[allow(dead_code)]` on non-Linux targets since non-Linux platforms use the stub `start_stylus_stream` that returns immediately without emitting channel messages.

**Verify**: `cd inkwell-app/src-tauri; cargo clippy --all-targets` → zero warnings.

## Test plan

- Run `cd inkwell; cargo test` and verify 57/57 tests pass.
- Run `cd inkwell-app/src-tauri; cargo test` and verify backend builds and tests pass.

## Done criteria

- [ ] `cd inkwell; cargo clippy --all-targets` completes with 0 warnings.
- [ ] `cd inkwell-app/src-tauri; cargo clippy --all-targets` completes with 0 warnings.
- [ ] All unit and integration tests continue to pass with exit code 0.
- [ ] `plans/README.md` status row updated to DONE.

## STOP conditions

- If adding `#[cfg(target_os = "linux")]` causes compilation errors on Linux platforms due to missing types in public signatures, replace with `#[allow(dead_code)]`.

## Maintenance notes

- Any new platform-specific hardware drivers (e.g. Windows Ink, macOS trackpad force) must include non-target stubs and proper `#[cfg]` gating to keep builds warning-free.
