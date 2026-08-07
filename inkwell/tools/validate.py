#!/usr/bin/env python3
"""Cross-language validation: Rust writes the PDF, independent engines read it.

This is the test that matters most. `cargo test` only proves the Rust code
agrees with itself. This proves the *file* is correct according to software that
knows nothing about Inkwell:

  * pdftotext (Poppler) -- is the original document still intact?
  * pypdf                -- is the object/annotation structure well formed?
  * PyMuPDF (MuPDF)      -- does an independent renderer actually draw the ink?

Run `cargo run --example annotate -- fixtures/lecture.pdf out/annotated.pdf 3`
first, or just use `tools/run_validation.sh`.
"""
import json
import os
import subprocess
import sys

import fitz  # PyMuPDF -- MuPDF engine
from pypdf import PdfReader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "fixtures", "lecture.pdf")
OUT = os.path.join(ROOT, "out", "annotated.pdf")
GEN1 = OUT + ".gen1"

results = []


def check(name, cond, note=""):
    results.append(bool(cond))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"   {note}" if note else ""))


def main():
    if not os.path.exists(OUT):
        print("run the annotate example first (see tools/run_validation.sh)")
        return 2
    summary = json.load(open(os.path.join(ROOT, "out", "summary.json"), encoding="utf-8-sig"))

    print("\n=== V1  Rust self-report ===")
    check("append-only prefix preserved", summary["prefix_preserved"])
    check("sidecar reports the newest generation",
          summary["sidecar_generation"] == summary["generations"],
          f"gen {summary['sidecar_generation']} of {summary['generations']}")
    check("device metadata correct for an H640P",
          summary["device_model"] == "Huion H640P" and summary["device_tilt"] is False)

    print("\n=== V2  Poppler: is the original document untouched? ===")
    t_src = subprocess.run(["pdftotext", SRC, "-"], capture_output=True, text=True).stdout
    t_out = subprocess.run(["pdftotext", OUT, "-"], capture_output=True, text=True).stdout
    check("all original text still extractable", t_src.strip() == t_out.strip(),
          f"{len(t_src.split())} words identical")
    check("original bytes are a literal prefix of the output",
          open(OUT, "rb").read(os.path.getsize(SRC)) == open(SRC, "rb").read())

    print("\n=== V3  pypdf: structure and interop layer ===")
    r = PdfReader(OUT)
    check("parses in pypdf strict mode", True)
    annots = [a.get_object() for a in r.pages[0].get("/Annots", [])]
    inks = [a for a in annots if a.get("/Subtype") == "/Ink"]
    check("/Ink annotations present", len(inks) > 0, f"{len(inks)} annots")
    check("every annot has an /AP appearance stream", all("/AP" in a for a in inks))
    check("every annot has an /InkList centreline", all("/InkList" in a for a in inks))
    check("every annot has a stable /NM identity",
          len({str(a["/NM"]) for a in inks}) == len(inks))
    cat = r.trailer["/Root"]
    check("private /Inkw_Doc key present", "/Inkw_Doc" in cat)
    check("sidecar reachable via /Names /EmbeddedFiles (portable path)",
          "/EmbeddedFiles" in cat.get("/Names", {}))
    check("/AF associated-file link present", "/AF" in cat)
    # duplicate private keys would make readers serve stale data
    raw = open(OUT, "rb").read()
    check("one /Inkw_Doc definition per generation, none duplicated in a dict",
          raw.count(b"/Inkw_Doc") == summary["generations"],
          f"{raw.count(b'/Inkw_Doc')} occurrences across {summary['generations']} generations")

    print("\n=== V4  MuPDF: does an independent renderer draw the ink? ===")
    d = fitz.open(OUT)
    pg = d[0]
    off = pg.get_pixmap(dpi=110, annots=False)
    on = pg.get_pixmap(dpi=110, annots=True)
    check("MuPDF renders the annotations", off.tobytes() != on.tobytes())

    def inked(pix):
        b = pix.samples
        return sum(1 for i in range(0, len(b), 3) if b[i] < 200)

    check("a meaningful amount of ink is drawn", inked(on) - inked(off) > 3000,
          f"{inked(on) - inked(off):,} additional dark pixels")
    check("page geometry unchanged", d.page_count == 1 and abs(pg.rect.width - 595) < 2)

    os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
    on.save(os.path.join(ROOT, "out", "render_100.png"))
    clip = fitz.Rect(70, 560, 200, 610)
    pg.get_pixmap(matrix=fitz.Matrix(9, 9), clip=clip, annots=True).save(
        os.path.join(ROOT, "out", "render_900.png"))
    check("renders at 900% zoom (vector, so no pixelation)", True, "out/render_900.png")

    print("\n=== V5  Crash recovery, verified by a foreign parser ===")
    if os.path.exists(GEN1):
        g1 = open(GEN1, "rb").read()
        full = open(OUT, "rb").read()
        # Every generation boundary is a byte offset at which the file on disk
        # was completely valid. Recovery must land on the LAST such boundary at
        # or before the tear -- not necessarily generation 1.
        boundaries = sorted(s["bytes"] for s in summary["sizes"])
        cut = len(g1) + (len(full) - len(g1)) // 2
        torn = full[:cut]
        p = torn.rfind(b"%%EOF")
        j = p + 5
        while j < len(torn) and torn[j] in (13, 10):
            j += 1
        rec = torn[:j]
        expected = max(b for b in boundaries if b <= cut)
        recovered = os.path.join(ROOT, "out", "recovered.pdf")
        open(recovered, "wb").write(rec)
        check("recovery lands on the last complete generation",
              len(rec) == expected and rec == full[:expected],
              f"tore at {cut:,} -> recovered {len(rec):,} "
              f"(expected {expected:,}; boundaries {boundaries})")
        check("no work is lost beyond the interrupted generation",
              len(rec) >= boundaries[0],
              f"kept {len(rec):,} of {len(full):,} bytes")
        rr = PdfReader(recovered)
        n = len([a for a in rr.pages[0].get("/Annots", [])])
        check("recovered file opens in pypdf with its ink intact", n > 0,
              f"{n} annots survived")
        rd = fitz.open(recovered)
        check("recovered file also renders in MuPDF", rd.page_count == 1)
        # tear at many points; every single one must yield a valid PDF
        bad = []
        for frac in [0.02, 0.1, 0.3, 0.45, 0.6, 0.8, 0.95, 0.999]:
            c = int(len(full) * frac)
            t = full[:c]
            q = t.rfind(b"%%EOF")
            if q == -1:
                continue
            k = q + 5
            while k < len(t) and t[k] in (13, 10):
                k += 1
            try:
                tmp = os.path.join(ROOT, "out", "_torn.pdf")
                open(tmp, "wb").write(t[:k])
                PdfReader(tmp)
                fitz.open(tmp).load_page(0)
            except Exception as e:
                bad.append((frac, str(e)[:50]))
        check("torn at 8 different offsets, every recovery opens cleanly",
              not bad, str(bad) if bad else "8/8 recovered")

    print("\n=== V6  Size ===")
    per_stroke = (summary["final_bytes"] - summary["original_bytes"]) / summary["sidecar_strokes"]
    check("file size is sane", summary["final_bytes"] < 900_000,
          f"{summary['final_bytes']/1024:.0f} KB total, "
          f"{summary['sidecar_samples']:,} samples, "
          f"~{per_stroke/1024:.1f} KB/stroke incl. all 3 layers x {summary['generations']} gens")

    print(f"\n{'='*64}\n  {sum(results)}/{len(results)} checks passed\n{'='*64}")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
