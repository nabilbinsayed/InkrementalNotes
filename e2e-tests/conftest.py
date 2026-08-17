"""e2e-tests/conftest.py — Pytest Fixtures, Generators, and Shared Helpers.

Provides fixtures for:
  - Temporary workspace directories
  - Pre-generated valid/malformed PDF buffers
  - Synthetic pen and touch pointer sample streams
  - Simulated Tauri IPC instances
  - Codec, WAL, and Stroke factory helpers
"""

import pytest
import shutil
import tempfile
import pathlib
from typing import Generator, List, Tuple
from harness import (
    SimulatedInkwellIPC,
    Stroke,
    Sample,
    Brush,
    make_sample_pdf,
    OneEuro,
)

@pytest.fixture
def temp_workspace() -> Generator[pathlib.Path, None, None]:
    """Create and tear down an isolated temporary workspace directory."""
    d = tempfile.mkdtemp(prefix="inkwell_e2e_")
    path = pathlib.Path(d)
    try:
        yield path
    finally:
        shutil.rmtree(d, ignore_errors=True)

@pytest.fixture
def sample_pdf_buffer() -> bytes:
    """Generate a standard single-page PDF 1.7 buffer."""
    return make_sample_pdf(page_count=1, width_pt=612.0, height_pt=792.0)

@pytest.fixture
def multi_page_pdf_buffer() -> bytes:
    """Generate a 5-page PDF 1.7 buffer."""
    return make_sample_pdf(page_count=5, width_pt=595.0, height_pt=842.0)

@pytest.fixture
def sample_stroke() -> Stroke:
    """Create a standard pen stroke with 20 curved samples."""
    samples = []
    for i in range(20):
        t = i / 19.0
        x = 100.0 + t * 200.0
        y = 150.0 + 50.0 * (t ** 2)
        p = 0.2 + 0.6 * (1.0 - abs(t - 0.5) * 2)
        t_ms = i * 8.33
        samples.append(Sample(x=x, y=y, p=p, t=t_ms))
    return Stroke(
        id=0x0123456789ABCDEF0123456789ABCDEF,
        kind="pen",
        rgb=(0.1, 0.2, 0.9),
        brush=Brush(base_width=3.2, gamma=1.0, min_ratio=0.22),
        samples=samples,
    )

@pytest.fixture
def sample_highlighter_stroke() -> Stroke:
    """Create a standard chisel highlighter stroke."""
    samples = [
        Sample(x=50.0, y=100.0, p=0.8, t=0.0),
        Sample(x=150.0, y=100.0, p=0.8, t=16.6),
        Sample(x=250.0, y=100.0, p=0.8, t=33.3),
    ]
    return Stroke(
        id=0xFEDCBA9876543210FEDCBA9876543210,
        kind="highlighter",
        rgb=(1.0, 0.9, 0.2),
        brush=Brush(base_width=16.0, gamma=1.0, min_ratio=1.0),
        samples=samples,
    )

@pytest.fixture
def mock_ipc(temp_workspace: pathlib.Path) -> SimulatedInkwellIPC:
    """Provide a clean in-memory Tauri IPC instance."""
    return SimulatedInkwellIPC(temp_dir=str(temp_workspace))
