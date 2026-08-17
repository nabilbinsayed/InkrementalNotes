# SCOPE — E2E Testing Track Orchestrator (sub_orch_e2e_gen2)

## Mission
Build, execute, and verify the complete, independent, opaque-box E2E test suite for InkWell covering all 23 features (F01-F23) from PROJECT.md across Tiers 1-4. Publish TEST_READY.md upon gate pass.

## Feature Inventory (23 Features)
| # | Feature | Description | Requirement | Target Test Tier |
|---|---|---|---|---|
| F01 | Zero DOM Reflows in Pen Loop | No forced synchronous getBoundingClientRect in consume / pointer handlers | R1 (020) | T1 (5), T2 (5), T3, T4 |
| F02 | Zero Per-Sample Allocations | Precomputed CSS color strings, no toFixed / array joins in hot inking path | R1 (020) | T1 (5), T2 (5), T3, T4 |
| F03 | Path2D Ribbon Retention | Eager Path2D caching and reuse on redraw | R1 (020) | T1 (5), T2 (5), T3, T4 |
| F04 | Dirty Bounding Box Clear | Clear only dirty bounding box on pen-up instead of full viewport wipe | R1 (020) | T1 (5), T2 (5), T3, T4 |
| F05 | Non-Blocking PDFium Threadpool | spawn_blocking for PDFium rasterization in render_tile | R2 (021) | T1 (5), T2 (5), T3, T4 |
| F06 | Document Handle & Bitmap Caching | Reuse open document handles & bitmap cache, no byte re-parsing per tile | R2 (021) | T1 (5), T2 (5), T3, T4 |
| F07 | Sub-Rectangle Tile Rasterization | Sub-rectangle bounds rendering, eliminate 8kx8k full-page bitmap allocations | R2 (021) | T1 (5), T2 (5), T3, T4 |
| F08 | Tile Error Backoff | Error caching and backoff, prevent recursive scheduleRedrawTiles storms | R2 (021) | T1 (5), T2 (5), T3, T4 |
| F09 | Multi-Document Backend Sessions | AppState session map keyed by ID, switch_document IPC | R3 (022) | T1 (5), T2 (5), T3, T4 |
| F10 | Tab Switching Synchronization | switchTab synchronizes active document session with backend | R3 (022) | T1 (5), T2 (5), T3, T4 |
| F11 | Undo / Redo Synchronization | Undo and redo dispatch delete_stroke and commit_stroke to Rust & WAL | R3 (022) | T1 (5), T2 (5), T3, T4 |
| F12 | Selection Mutation Durability | Lasso deletions, transforms, duplicate/paste commit to Rust & WAL | R3 (022) | T1 (5), T2 (5), T3, T4 |
| F13 | WAL Flush on Shutdown | Window close handler flushes WAL and terminates cleanly | R3 (022) | T1 (5), T2 (5), T3, T4 |
| F14 | Safe UTF-8 PDF Search | Safe character-boundary slicing for Unicode/non-ASCII search queries | R4 (023) | T1 (5), T2 (5), T3, T4 |
| F15 | Secure DLL Resolution | Restrict PDFium DLL search to exe dir, PDFIUM_DLL_DIR, system library | R4 (023) | T1 (5), T2 (5), T3, T4 |
| F16 | Varint Decoder Overflow Bounds | Bounded pre-allocations and overflow checks in codec.rs | R4 (023) | T1 (5), T2 (5), T3, T4 |
| F17 | PDF Object Stream Bounds Clamping | Clamped end offsets and boundary checks in pdfobj.rs | R4 (023) | T1 (5), T2 (5), T3, T4 |
| F18 | Path Traversal Sanitization | save_pdf validates paths against directory traversal & enforces .pdf | R4 (023) | T1 (5), T2 (5), T3, T4 |
| F19 | Strict Content Security Policy | Enforce strict CSP in tauri.conf.json | R4 (023) | T1 (5), T2 (5), T3, T4 |
| F20 | Palm Rejection & Stylus Isolation | Ignore touch events while pen is active, avoid stroke clobbering | R5 (024) | T1 (5), T2 (5), T3, T4 |
| F21 | Multi-Touch Pinch-to-Zoom | 2-finger touch tracking in ViewportManager with zoom scaling | R5 (024) | T1 (5), T2 (5), T3, T4 |
| F22 | Spatial Indexing & AABB Pre-filtering | O(1) stroke AABB checks in eraser, lasso, hit-testing in JS and Rust | R6 (025) | T1 (5), T2 (5), T3, T4 |
| F23 | Thumbnail Virtualization & A11y | Virtualized thumbnail drawer, 45° chisel ribbon, >=44px touch targets & focus trap | R5/R6 (024-026) | T1 (5), T2 (5), T3, T4 |

## Target Test Suite Architecture
- `e2e-tests/harness.py`: Pure Python + CDP/IPC test harness capable of running headless or simulated tests against the InkWell core, PDF engine, IPC protocols, and UI canvas state.
- `e2e-tests/conftest.py`: Pytest configuration, fixtures for temp documents, simulated IPC state, sample PDF fixtures.
- `e2e-tests/test_tier1_features.py`: 115 tests (5 tests x 23 features).
- `e2e-tests/test_tier2_boundaries.py`: 115 tests (boundary values, extreme inputs, nulls, unicode boundaries, max sizes).
- `e2e-tests/test_tier3_pairwise.py`: 25+ tests (pairwise interactions between features).
- `e2e-tests/test_tier4_workloads.py`: 12+ tests (end-to-end realistic user workflows).
- `e2e-tests/run_all.py`: Unified test runner executing all 4 tiers with formatted pass/fail summary and exit code 0 on complete pass.
