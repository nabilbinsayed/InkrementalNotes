import sys
import math
import random
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
E2E_DIR = REPO_ROOT / "e2e-tests"
sys.path.insert(0, str(E2E_DIR))

import harness
from harness import (
    Stroke, Sample, Brush, aabb_intersects, erase_strokes_near
)

def debug_mismatch():
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

    for q_idx in range(1000):
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
        if set(actual_removed) != set(expected_removed):
            print(f"Query {q_idx}: qx={qx}, qy={qy}, radius={radius}")
            print(f"Actual: {actual_removed}, Expected: {expected_removed}")
            diff = set(expected_removed) - set(actual_removed)
            for missing_id in diff:
                s = next(st for st in strokes if st.id == missing_id)
                sb = s.bbox()
                qbox = [qx - radius, qy - radius, qx + radius, qy + radius]
                intersects = aabb_intersects(sb, qbox)
                print(f"Stroke {s.id}: base_width={s.brush.base_width}, gamma={s.brush.gamma}, min_ratio={s.brush.min_ratio}")
                print(f"  bbox: {sb}")
                print(f"  qbox: {qbox}")
                print(f"  aabb_intersects: {intersects}")
                for idx, sm in enumerate(s.samples):
                    dist = math.hypot(sm.x - qx, sm.y - qy)
                    w_actual = s.brush.width_for(sm.p)
                    w_base = s.brush.base_width
                    thresh = radius + w_base * 0.5
                    print(f"  samp[{idx}]: x={sm.x}, y={sm.y}, p={sm.p}, dist={dist}, thresh={thresh}, width_for_p={w_actual}")
            break

if __name__ == "__main__":
    debug_mismatch()
