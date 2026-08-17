"""probe_tautologies_and_mutants.py — Mutation Testing & Tautology Discovery.

Author: e2e_challenger_2
Purpose: Classify every test in Tier 1-4 as:
  1. TAUTOLOGICAL (tests only local python variables/primitives without testing real code or harness)
  2. SHALLOW_SYNTACTIC (checks substring in static file, e.g. 'assert "main" in content')
  3. SPECIFICATION_ORACLE (verifies mathematical/stateful behavioral properties of harness/system)
  4. INTEGRATION_WORKLOAD (verifies multi-step user workflows and cross-tier invariants)
"""

import ast
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
TESTS_DIR = REPO_ROOT / "e2e-tests"

def analyze_test_file(file_path: pathlib.Path):
    tree = ast.parse(file_path.read_text(encoding="utf-8"), filename=str(file_path))
    class_tests = []
    
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name.startswith("test_"):
            # Extract docstring and body
            docstring = ast.get_docstring(node) or ""
            source_lines = [ast.unparse(s) for s in node.body if not isinstance(s, ast.Expr) or not isinstance(s.value, ast.Constant)]
            
            # Heuristic classification
            body_str = " ".join(source_lines)
            
            is_static_substring = "read_text(" in body_str and "assert" in body_str and ("in content" in body_str or "exists()" in body_str)
            
            is_local_tautology = False
            if not is_static_substring:
                # Check if it only defines literals and asserts on them
                calls_harness = any(h in body_str for h in [
                    "mock_ipc", "Wal", "decode_strokes", "encode_strokes",
                    "get_uvarint", "put_uvarint", "get_varint", "put_varint",
                    "OneEuro", "simplify_rdp", "ribbon_outline", "get_chisel_polygon",
                    "aabb_intersects", "erase_strokes_near", "erase_strokes_in_rect",
                    "validate_save_path", "safe_utf8_search_snippet", "make_sample_pdf",
                    "atomic_write", "fnv1a_checksum"
                ])
                if not calls_harness and not any(arg.arg in ["sample_stroke", "sample_highlighter_stroke", "mock_ipc", "temp_workspace", "sample_pdf_buffer"] for arg in node.args.args):
                    is_local_tautology = True
            
            category = "INTEGRATION_WORKLOAD" if "workflow" in node.name or "pairwise" in node.name else (
                "SHALLOW_SYNTACTIC" if is_static_substring else (
                    "TAUTOLOGICAL" if is_local_tautology else "SPECIFICATION_ORACLE"
                )
            )
            
            class_tests.append((node.name, category, docstring, source_lines))
            
    return class_tests

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
        
    files = [
        TESTS_DIR / "test_tier1_features.py",
        TESTS_DIR / "test_tier2_boundaries.py",
        TESTS_DIR / "test_tier3_pairwise.py",
        TESTS_DIR / "test_tier4_workloads.py",
    ]
    
    total = 0
    cat_counts = {}
    
    for f in files:
        results = analyze_test_file(f)
        total += len(results)
        print(f"\n{'='*70}\nFILE: {f.name} ({len(results)} tests)\n{'='*70}")
        file_counts = {}
        for name, cat, doc, lines in results:
            file_counts[cat] = file_counts.get(cat, 0) + 1
            cat_counts[cat] = cat_counts.get(cat, 0) + 1
            if cat in ["TAUTOLOGICAL", "SHALLOW_SYNTACTIC"]:
                print(f"  [{cat}] {name}")
                if lines:
                    print(f"      -> {lines[-1][:80]}")
        print(f"Summary for {f.name}: {file_counts}")
        
    print(f"\n{'='*70}\nOVERALL SUITE BREAKDOWN (Total: {total} tests)\n{'='*70}")
    for cat, count in cat_counts.items():
        pct = (count / total) * 100
        print(f"  {cat:<25}: {count:4d} ({pct:5.1f}%)")
    print(f"{'='*70}")

if __name__ == "__main__":
    main()
