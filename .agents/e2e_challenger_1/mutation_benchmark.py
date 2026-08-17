"""
Mutation & Oracle Sensitivity Test Harness for InkWell E2E Suite.
Adversarially injects bugs into:
1. Varint codec (zigzag, leb128, overflow, magic)
2. Coordinate geometry & ribbon outline math
3. WAL journal replay, checksum, torn record recovery
4. Spatial indexing (AABB intersection, point/rect eraser)
5. Security sanitization (path traversal, UTF-8 search)
6. Production config / code inspection (CSP, static guards)

Records mutant survival (test suite passed despite bug) vs mutant killed (test suite failed).
"""

import os
import sys
import copy
import time
import shutil
import pathlib
import subprocess

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
E2E_DIR = REPO_ROOT / "e2e-tests"

def find_pytest_and_python():
    candidates = [
        pathlib.Path(r"C:\Users\nabil\AppData\Local\hermes\hermes-agent\venv\Scripts\pytest.exe"),
        pathlib.Path(sys.executable).parent / "pytest.exe",
    ]
    pytest_bin = "pytest"
    for c in candidates:
        if c.exists():
            pytest_bin = str(c)
            break
    return pytest_bin

PYTEST_BIN = find_pytest_and_python()

def run_tests_capture(tier_file=None):
    """Run pytest subprocess and return (exit_code, output)."""
    target = str(tier_file) if tier_file else str(E2E_DIR)
    res = subprocess.run(
        [PYTEST_BIN, target, "-q", "--no-header"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    return res.returncode, res.stdout + res.stderr

def run_mutation_trial(name, setup_fn, teardown_fn, expected_failed_tier=None):
    """Execute a single mutation trial."""
    print(f"[*] Testing Mutant: {name} ... ", end="", flush=True)
    setup_fn()
    try:
        ret, out = run_tests_capture(expected_failed_tier)
        # If ret != 0, mutant was KILLED (good, test oracle detected the defect)
        # If ret == 0, mutant SURVIVED (bad, test oracle missed the defect)
        if ret != 0:
            print(f"KILLED (exit {ret}) -> Oracle sensitive")
            return {"name": name, "status": "KILLED", "exit_code": ret, "output": out[:200]}
        else:
            print("SURVIVED! -> Oracle insensitive / Blind spot!")
            return {"name": name, "status": "SURVIVED", "exit_code": ret, "output": out[:200]}
    finally:
        teardown_fn()

def main():
    mutations_results = []
    harness_py = E2E_DIR / "harness.py"
    orig_harness_code = harness_py.read_text(encoding="utf-8")

    tauri_conf = REPO_ROOT / "inkwell-app" / "src-tauri" / "tauri.conf.json"
    orig_tauri_conf = tauri_conf.read_text(encoding="utf-8") if tauri_conf.exists() else ""

    app_js = REPO_ROOT / "inkwell-app" / "src" / "js" / "app.js"
    orig_app_js = app_js.read_text(encoding="utf-8") if app_js.exists() else ""

    def restore_harness():
        harness_py.write_text(orig_harness_code, encoding="utf-8")

    # -------------------------------------------------------------
    # 1. Mutate zigzag / unzigzag encoding in harness.py
    # -------------------------------------------------------------
    def mut_zigzag_off_by_one():
        mutated = orig_harness_code.replace(
            "return ((n << 1) ^ (n >> 63)) & 0xFFFFFFFFFFFFFFFF",
            "return (((n << 1) + 1) ^ (n >> 63)) & 0xFFFFFFFFFFFFFFFF"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_01_VARINT_ZIGZAG_OFF_BY_ONE", mut_zigzag_off_by_one, restore_harness)
    )

    # -------------------------------------------------------------
    # 2. Mutate uvarint overflow check (remove shift > 63 guard)
    # -------------------------------------------------------------
    def mut_uvarint_no_overflow_check():
        mutated = orig_harness_code.replace(
            "if shift > 63:\n            raise ValueError(\"Varint overflow: shift exceeds 63 bits\")",
            "if False:\n            pass"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_02_VARINT_NO_OVERFLOW_GUARD", mut_uvarint_no_overflow_check, restore_harness)
    )

    # -------------------------------------------------------------
    # 3. Mutate Codec Magic validation (accept invalid magic)
    # -------------------------------------------------------------
    def mut_codec_magic_bypass():
        mutated = orig_harness_code.replace(
            "if len(buf) < 5 or buf[:4] != MAGIC_CODEC:\n        raise ValueError(\"Bad magic: not an InkWell stroke payload\")",
            "if False:\n        pass"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_03_CODEC_MAGIC_BYPASS", mut_codec_magic_bypass, restore_harness)
    )

    # -------------------------------------------------------------
    # 4. Mutate WAL Checksum verification in replay (skip checksum check)
    # -------------------------------------------------------------
    def mut_wal_skip_checksum_verify():
        mutated = orig_harness_code.replace(
            "if fnv1a_checksum(payload) != want_chk:\n                break  # Corrupt or torn tail",
            "if False:\n                break"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_04_WAL_SKIP_CHECKSUM_VERIFY", mut_wal_skip_checksum_verify, restore_harness)
    )

    # -------------------------------------------------------------
    # 5. Mutate WAL Torn Record detection (allow reading past buffer end)
    # -------------------------------------------------------------
    def mut_wal_ignore_torn_tail():
        mutated = orig_harness_code.replace(
            "if ce > len(buf):\n                break  # Torn tail",
            "if False:\n                break"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_05_WAL_IGNORE_TORN_TAIL", mut_wal_ignore_torn_tail, restore_harness)
    )

    # -------------------------------------------------------------
    # 6. Mutate Spatial AABB Intersection (always return False)
    # -------------------------------------------------------------
    def mut_aabb_always_disjoint():
        mutated = orig_harness_code.replace(
            "return not (box1[2] < box2[0] or box1[0] > box2[2] or\n                box1[3] < box2[1] or box1[1] > box2[3])",
            "return False"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_06_AABB_ALWAYS_DISJOINT", mut_aabb_always_disjoint, restore_harness)
    )

    # -------------------------------------------------------------
    # 7. Mutate Spatial Eraser: radius check corrupted
    # -------------------------------------------------------------
    def mut_eraser_radius_zero():
        mutated = orig_harness_code.replace(
            "if math.hypot(samp.x - px, samp.y - py) < (radius + s.brush.base_width * 0.5):",
            "if math.hypot(samp.x - px, samp.y - py) < 0.0:"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_07_ERASER_RADIUS_ZERO", mut_eraser_radius_zero, restore_harness)
    )

    # -------------------------------------------------------------
    # 8. Mutate Ribbon Outline: normal vector calculation zeroed
    # -------------------------------------------------------------
    def mut_ribbon_normal_zero():
        mutated = orig_harness_code.replace(
            "nx, ny = -dy / l, dx / l",
            "nx, ny = 0.0, 0.0"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_08_RIBBON_NORMAL_ZERO", mut_ribbon_normal_zero, restore_harness)
    )

    # -------------------------------------------------------------
    # 9. Mutate OneEuro Filter: return raw value unfiltered
    # -------------------------------------------------------------
    def mut_one_euro_bypass():
        mutated = orig_harness_code.replace(
            "self.x_prev = out\n        return out",
            "self.x_prev = out\n        return v"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_09_ONE_EURO_BYPASS", mut_one_euro_bypass, restore_harness)
    )

    # -------------------------------------------------------------
    # 10. Mutate Path Traversal Validator: allow ".."
    # -------------------------------------------------------------
    def mut_path_traversal_allow():
        mutated = orig_harness_code.replace(
            'if ".." in parts:\n        return False, "Directory traversal (\'..\') is strictly prohibited"',
            "if False:\n        pass"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_10_PATH_TRAVERSAL_ALLOW_DOTDOT", mut_path_traversal_allow, restore_harness)
    )

    # -------------------------------------------------------------
    # 11. Mutate UTF-8 Search: substring matching broken (case sensitive)
    # -------------------------------------------------------------
    def mut_search_broken_case():
        mutated = orig_harness_code.replace(
            'full_text_lower = "".join(chars).lower()',
            'full_text_lower = "".join(chars)'
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_11_SEARCH_CASE_SENSITIVE_BUG", mut_search_broken_case, restore_harness)
    )

    # -------------------------------------------------------------
    # 12. Mutate production tauri.conf.json: Remove CSP
    # -------------------------------------------------------------
    def mut_tauri_conf_remove_csp():
        if tauri_conf.exists():
            data = tauri_conf.read_text(encoding="utf-8")
            data_no_csp = data.replace('"csp"', '"_disabled_csp"')
            tauri_conf.write_text(data_no_csp, encoding="utf-8")

    def restore_tauri_conf():
        if orig_tauri_conf:
            tauri_conf.write_text(orig_tauri_conf, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_12_TAURI_CONF_REMOVE_CSP", mut_tauri_conf_remove_csp, restore_tauri_conf)
    )

    # -------------------------------------------------------------
    # 13. Mutate Undo/Redo: undo does not remove stroke from session
    # -------------------------------------------------------------
    def mut_undo_no_op():
        mutated = orig_harness_code.replace(
            "sess.strokes[sheet] = [s for s in sess.strokes[sheet] if s.id != stroke.id]",
            "pass"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_13_UNDO_DOES_NOT_REMOVE_STROKE", mut_undo_no_op, restore_harness)
    )

    # -------------------------------------------------------------
    # 14. Mutate Sub-Rectangle Tile Render: inverted rect check disabled
    # -------------------------------------------------------------
    def mut_render_tile_accept_inverted():
        mutated = orig_harness_code.replace(
            "if not (all(math.isfinite(v) for v in rect) and rect[2] > rect[0] and rect[3] > rect[1]):",
            "if False:"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_14_RENDER_TILE_ACCEPT_INVERTED_RECT", mut_render_tile_accept_inverted, restore_harness)
    )

    # -------------------------------------------------------------
    # 15. Mutate RDP Simplification: always return all points (no decimation)
    # -------------------------------------------------------------
    def mut_rdp_no_decimation():
        mutated = orig_harness_code.replace(
            "return [s for s, k in zip(pts, keep) if k]",
            "return list(pts)"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_15_RDP_NO_DECIMATION", mut_rdp_no_decimation, restore_harness)
    )

    # -------------------------------------------------------------
    # 16. Mutate 45-degree Chisel angle calculation: angle zeroed
    # -------------------------------------------------------------
    def mut_chisel_angle_zero():
        mutated = orig_harness_code.replace(
            "hx = half_h * math.cos(angle_rad)",
            "hx = 0.0"
        )
        assert mutated != orig_harness_code, "Target not found"
        harness_py.write_text(mutated, encoding="utf-8")

    mutations_results.append(
        run_mutation_trial("MUT_16_CHISEL_ANGLE_ZEROED", mut_chisel_angle_zero, restore_harness)
    )

    # -------------------------------------------------------------
    # Summary
    # -------------------------------------------------------------
    print("\n" + "=" * 80)
    print("MUTATION TESTING SUMMARY REPORT")
    print("=" * 80)
    killed = sum(1 for m in mutations_results if m["status"] == "KILLED")
    survived = sum(1 for m in mutations_results if m["status"] == "SURVIVED")
    total = len(mutations_results)

    for m in mutations_results:
        print(f"[{m['status']:<8}] {m['name']}")

    print("-" * 80)
    print(f"Total Mutants: {total} | Killed: {killed} | Survived: {survived}")
    score = (killed / total) * 100.0 if total > 0 else 0.0
    print(f"Mutation Score: {score:.1f}%")
    print("=" * 80)

    # Save results to json
    res_path = pathlib.Path(__file__).resolve().parent / "mutation_results.json"
    import json
    res_path.write_text(json.dumps(mutations_results, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
