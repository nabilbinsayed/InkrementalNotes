"""
Adversarial Stress Harness for InkWell E2E Reference Model & Verifiers.
Executes deep stress trials:
1. WAL byte-by-byte torn tail truncation fuzzing (every byte offset from 0..len)
2. Varint & Codec fuzzing with random bytes, malformed payloads, large coordinates
3. Coordinate transform & Ribbon geometry stress (extreme collinearity, zero-length, loopbacks)
4. Spatial indexing vs naive ground truth over 1000 randomized queries
5. Unicode search fuzzer over complex scripts, combining marks, surrogate pairs, and ZWJ
"""

import sys
import math
import random
import pathlib
import struct

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
E2E_DIR = REPO_ROOT / "e2e-tests"
sys.path.insert(0, str(E2E_DIR))

import harness
from harness import (
    Stroke, Sample, Brush, OneEuro, Wal, WalEntryAdded, WalEntryRemoved,
    WalEntryPageInserted, encode_strokes, decode_strokes, put_uvarint, get_uvarint,
    put_varint, get_varint, ribbon_outline, get_chisel_polygon,
    aabb_intersects, erase_strokes_near, erase_strokes_in_rect,
    safe_utf8_search_snippet, validate_save_path, simplify_rdp
)

def test_wal_byte_by_byte_truncation_fuzz():
    print("[*] Running WAL byte-by-byte truncation fuzzer ... ", end="")
    # Create WAL with multiple entries
    entries = []
    for i in range(10):
        samples = [Sample(x=10.0*i + j, y=20.0*i + j, p=0.5, t=j*10.0) for j in range(5)]
        s = Stroke(id=1000 + i, kind="pen" if i % 2 == 0 else "highlighter", rgb=(0.1, 0.2, 0.3), brush=Brush(), samples=samples)
        entries.append(WalEntryAdded(sheet=i % 3, stroke=s))
        entries.append(WalEntryRemoved(id=900 + i))
        entries.append(WalEntryPageInserted(index=i, width_pt=612.0, height_pt=792.0))

    import tempfile
    with tempfile.TemporaryDirectory() as td:
        wpath = pathlib.Path(td) / "fuzz.wal"
        wal = Wal(wpath)
        for e in entries:
            wal.append(e)

        full_bytes = wpath.read_bytes()
        total_len = len(full_bytes)

        # Fuzz every byte boundary: truncate at pos from 0 to total_len
        for cut in range(total_len + 1):
            truncated = full_bytes[:cut]
            # Must never raise unhandled exception or crash; must safely return prefix of valid entries
            replayed = Wal.replay(truncated)
            assert isinstance(replayed, list)
            # Replayed count must be <= total entries
            assert len(replayed) <= len(entries)

    print(f"PASSED ({total_len} truncation offsets tested safely)")

def test_codec_fuzz_random_bytes():
    print("[*] Running Codec random payload fuzzer (10,000 trials) ... ", end="")
    rng = random.Random(42)
    crashes = 0
    for _ in range(10000):
        length = rng.randint(0, 256)
        garbage = rng.randbytes(length)
        try:
            decode_strokes(garbage)
        except ValueError:
            # Expected on invalid magic, truncation, or overflow
            pass
        except Exception as e:
            # Unexpected exception (IndexError, TypeError, etc.)
            print(f"\n[FAIL] Unexpected exception on garbage input: {e}")
            crashes += 1
            break
    assert crashes == 0
    print("PASSED (0 unhandled crashes)")

def test_geometry_extreme_collinearity_and_loopbacks():
    print("[*] Running Ribbon Geometry extreme coordinates & loops ... ", end="")
    # 1. 100 identical overlapping points (zero-length segments)
    identical_pts = [Sample(100.0, 100.0, 0.5, i * 10.0) for i in range(100)]
    s1 = Stroke(id=1, kind="pen", rgb=(0, 0, 0), brush=Brush(base_width=4.0), samples=identical_pts)
    poly1 = ribbon_outline(s1)
    assert len(poly1) > 0
    assert all(math.isfinite(x) and math.isfinite(y) for x, y in poly1)

    # 2. Acute hairpin turns / 180-degree loopbacks
    hairpin_pts = [
        Sample(0.0, 0.0, 0.5, 0),
        Sample(100.0, 0.0, 0.5, 10),
        Sample(0.0, 0.0, 0.5, 20),
        Sample(100.0, 0.0, 0.5, 30),
    ]
    s2 = Stroke(id=2, kind="pen", rgb=(0, 0, 0), brush=Brush(base_width=4.0), samples=hairpin_pts)
    poly2 = ribbon_outline(s2)
    assert len(poly2) > 0
    assert all(math.isfinite(x) and math.isfinite(y) for x, y in poly2)

    # 3. Chisel with collinear and 0-length points
    chisel_pts = [(50.0, 50.0), (50.0, 50.0), (50.0, 50.0)]
    chisel_poly = get_chisel_polygon(chisel_pts, base_h=16.0, angle_rad=math.pi / 4)
    assert len(chisel_poly) == 6
    assert all(math.isfinite(x) and math.isfinite(y) for x, y in chisel_poly)

    print("PASSED")

def test_spatial_indexing_vs_naive_sweep():
    print("[*] Running Spatial Indexing vs Naive Ground Truth (1000 queries) ... ", end="")
    rng = random.Random(1337)
    strokes = []
    for i in range(200):
        bx = rng.uniform(0, 1000)
        by = rng.uniform(0, 1000)
        samples = [
            Sample(bx + rng.uniform(-20, 20), by + rng.uniform(-20, 20), rng.uniform(0.1, 1.0), j * 5)
            for j in range(rng.randint(3, 20))
        ]
        strokes.append(Stroke(id=i+1, kind="pen", rgb=(0, 0, 0), brush=Brush(base_width=rng.uniform(1, 10)), samples=samples))

    for _ in range(1000):
        qx = rng.uniform(0, 1000)
        qy = rng.uniform(0, 1000)
        radius = rng.uniform(5, 50)

        # Naive ground truth
        expected_removed = []
        for s in strokes:
            hit = False
            for samp in s.samples:
                if math.hypot(samp.x - qx, samp.y - qy) < (radius + s.brush.base_width * 0.5):
                    hit = True
                    break
            if hit:
                expected_removed.append(s.id)

        # Harness spatial index implementation
        _, actual_removed = erase_strokes_near(strokes, qx, qy, radius)
        assert set(actual_removed) == set(expected_removed), f"Mismatch: actual {actual_removed} vs expected {expected_removed}"

    print("PASSED (1000/1000 queries matched naive ground truth 100%)")

def test_unicode_search_adversarial_strings():
    print("[*] Running Unicode & RTL text search adversarial cases ... ", end="")
    cases = [
        ("مرحبا بالعالم", "العالم"),  # Arabic RTL
        ("שָׁלוֹם עוֹלָם", "עוֹלָם"),    # Hebrew with Niqqud
        ("こんにちは世界", "世界"),        # Japanese Kanji
        ("👨‍👩‍👧‍👦 family emoji test", "family"), # ZWJ Emoji sequence
        ("e\u0301 accent test", "e\u0301"),      # Combining character
        ("A" * 10000 + "TARGET" + "B" * 10000, "TARGET"), # 20KB large string
    ]
    for doc_text, query in cases:
        res = safe_utf8_search_snippet(doc_text, query)
        assert res is not None, f"Failed to match query '{query}' in document text"
        assert res[2] >= 1, "Match count should be >= 1"

    print("PASSED")

def main():
    print("=" * 80)
    print("  INKWELL E2E SUITE — ADVERSARIAL STRESS & FUZZ HARNESS")
    print("=" * 80)
    test_wal_byte_by_byte_truncation_fuzz()
    test_codec_fuzz_random_bytes()
    test_geometry_extreme_collinearity_and_loopbacks()
    test_spatial_indexing_vs_naive_sweep()
    test_unicode_search_adversarial_strings()
    print("=" * 80)
    print("ALL ADVERSARIAL STRESS TRIALS COMPLETED SUCCESSFULLY.")
    print("=" * 80)

if __name__ == "__main__":
    main()
