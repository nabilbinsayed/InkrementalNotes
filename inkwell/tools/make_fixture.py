#!/usr/bin/env python3
"""Generate the test fixture: a plain 'downloaded lecture notes' PDF.

Deliberately written by reportlab (classic xref table) so the Rust appender can
operate on it directly. Real-world PDFs often use xref streams; PdfFile::open
refuses those explicitly rather than corrupting them, and normalising them is
the job of the PDFium layer in `inkwell-pdf`.
"""
import os
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

OUT = os.path.join(os.path.dirname(__file__), "..", "fixtures")
os.makedirs(OUT, exist_ok=True)
path = os.path.join(OUT, "lecture.pdf")

W, H = A4
c = canvas.Canvas(path, pagesize=A4)
c.setTitle("Lecture 07 - Fourier Series")
c.setFont("Helvetica-Bold", 17)
c.drawString(62, H - 78, "Lecture 07 \u2014 Fourier Series")
c.setFont("Helvetica-Oblique", 10)
c.setFillColorRGB(.42, .42, .45)
c.drawString(62, H - 96, "MATH 2201  \u00b7  Week 4")
c.setFillColorRGB(0, 0, 0)
c.setFont("Helvetica", 11)
body = [
    "Any periodic function f(x) with period 2L can be represented as an infinite sum",
    "of sines and cosines. This representation is called the Fourier series of f.",
    "",
    "        f(x) = a0/2 + SUM[ an cos(n pi x / L) + bn sin(n pi x / L) ]",
    "",
    "The coefficients are obtained by exploiting orthogonality of the basis functions",
    "over one full period. Multiplying both sides by cos(m pi x / L) and integrating",
    "term by term collapses the sum to a single surviving term.",
    "",
    "        an = (1/L) INTEGRAL[-L..L] f(x) cos(n pi x / L) dx",
    "        bn = (1/L) INTEGRAL[-L..L] f(x) sin(n pi x / L) dx",
    "",
    "Convergence is guaranteed at every point of continuity by the Dirichlet theorem.",
    "At a jump discontinuity the series converges to the midpoint of the jump, and",
    "the partial sums overshoot near the jump by roughly 9% of the gap. This is the",
    "Gibbs phenomenon and it does not vanish as more terms are added.",
]
y = H - 140
for ln in body:
    c.drawString(62, y, ln)
    y -= 19
c.showPage()
c.save()
print(f"fixture: {path} ({os.path.getsize(path):,} bytes)")
