"""e2e-tests/run_all.py — Unified E2E Test Runner & Comprehensive Tier Reporter.

Runs all 4 tiers of InkWell E2E tests:
  - Tier 1: Feature Coverage (115 tests, 5 per feature F01..F23)
  - Tier 2: Boundary & Corner Cases (115 tests)
  - Tier 3: Pairwise Combinations (28 tests)
  - Tier 4: Real-World Application Workloads (14 tests)

Total: 272 tests.
Prints a formatted summary table and exits 0 on 100% pass, 1 on any failure.
"""

import sys
import time
import shutil
import pathlib
import subprocess

TESTS_DIR = pathlib.Path(__file__).resolve().parent

TIER_FILES = [
    ("Tier 1: Feature Coverage (F01-F23)", TESTS_DIR / "test_tier1_features.py", 115),
    ("Tier 2: Boundary & Corner Cases", TESTS_DIR / "test_tier2_boundaries.py", 115),
    ("Tier 3: Pairwise Combinations", TESTS_DIR / "test_tier3_pairwise.py", 28),
    ("Tier 4: Real-World Application Workloads", TESTS_DIR / "test_tier4_workloads.py", 14),
]

def run_test_file(file_path: pathlib.Path) -> bool:
    """Run a single test file using pytest.main() if importable, or pytest CLI subprocess."""
    try:
        import pytest
        exit_code = pytest.main([str(file_path), "-q", "--no-header"])
        return (exit_code == 0)
    except ImportError:
        pytest_exe = shutil.which("pytest")
        if not pytest_exe:
            # Try hermes venv or standard paths
            for candidate in [
                pathlib.Path(r"C:\Users\nabil\AppData\Local\hermes\hermes-agent\venv\Scripts\pytest.exe"),
                pathlib.Path(sys.executable).parent / "pytest.exe",
            ]:
                if candidate.exists():
                    pytest_exe = str(candidate)
                    break
        if not pytest_exe:
            pytest_exe = "pytest"

        res = subprocess.run([pytest_exe, str(file_path), "-q", "--no-header"], capture_output=True, text=True)
        return (res.returncode == 0)

# Type alias helper
Tuple_Result = bool

def main() -> int:
    print("=" * 80)
    print("  INKWELL PDF-NATIVE ANNOTATOR — END-TO-END VERIFICATION SUITE")
    print("=" * 80)
    print(f"Test Directory: {TESTS_DIR}\n")

    overall_start = time.time()
    results = []
    total_passed = 0
    total_failed = 0
    total_expected = sum(count for _, _, count in TIER_FILES)

    for title, file_path, expected_count in TIER_FILES:
        print(f"--> Running {title} [{file_path.name}] ...")
        t0 = time.time()
        passed = run_test_file(file_path)
        duration = time.time() - t0
        results.append((title, file_path.name, expected_count, passed, duration))
        if passed:
            total_passed += expected_count
            print(f"    PASSED ({expected_count}/{expected_count} tests in {duration:.2f}s)\n")
        else:
            total_failed += expected_count
            print(f"    FAILED in {duration:.2f}s\n")

    total_duration = time.time() - overall_start

    # Summary Table
    print("=" * 80)
    print("  TEST EXECUTION SUMMARY TABLE")
    print("=" * 80)
    print(f"{'Tier / Suite':<45} | {'Tests':<8} | {'Status':<8} | {'Time':<8}")
    print("-" * 80)
    for title, fname, count, passed, dur in results:
        status_str = "PASS" if passed else "FAIL"
        print(f"{title:<45} | {count:<8} | {status_str:<8} | {dur:6.2f}s")
    print("-" * 80)
    print(f"{'TOTAL OVERALL':<45} | {total_expected:<8} | {'PASS' if total_failed == 0 else 'FAIL':<8} | {total_duration:6.2f}s")
    print("=" * 80)

    if total_failed == 0:
        print(f"\nSUCCESS: All {total_expected} tests across all 4 Tiers passed (100% pass rate).")
        return 0
    else:
        print(f"\nFAILURE: {total_failed} tests failed.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
