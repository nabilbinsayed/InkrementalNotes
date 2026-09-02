# End-to-End Test Suite Status

The former Python tier suites (272 checks) exercised a Python re-implementation of the backend, not the product, and referenced the deleted monolithic `app.js`. Retired 2026-08 by Plan 045.

Product verification lives in:
- `inkwell-app/test_app_smoke.py` (Desktop frontend ES module & DOM pipeline)
- `cargo test --workspace` (Rust core, PDFium bindings, WAL, spatial index, and geometry math)

Pure-math boundary and codec fuzzing coverage exists as Rust integration tests in `inkwell/crates/*`.
