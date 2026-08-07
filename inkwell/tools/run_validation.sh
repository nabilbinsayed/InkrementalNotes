#!/usr/bin/env bash
# Full verification run: Rust unit/integration tests, then cross-language
# validation of the actual bytes by Poppler, pypdf and MuPDF.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> fixture"
python3 tools/make_fixture.py

echo "==> cargo test"
cargo test --quiet

echo "==> cargo run --example annotate (3 autosave generations)"
mkdir -p out
cargo run --quiet --example annotate -- fixtures/lecture.pdf out/annotated.pdf 3 \
  | tee out/summary.json

echo "==> cross-language validation"
python3 tools/validate.py
