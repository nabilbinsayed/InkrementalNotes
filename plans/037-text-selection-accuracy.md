# Plan 037 — High-Precision Character-Level Text Selection Engine

**Status**: UNFIXED (Requires further investigation & overhaul)  
**Priority**: P0  
**Effort**: M  

## Summary of Problem
The current PDF text selection implementation struggles with multi-line character snapping and linear selection bounds, occasionally wrapping incorrectly across line margins or failing to anchor cleanly on mouse drag. The automatic text snapping integration on the highlighter tool has been decoupled/removed as requested.

## Tasks for Follow-Up
1. Investigate PDF text layer extraction across varied PDF fonts, line matrices, and rotations in PDFium.
2. Build an isolated synthetic test suite comparing PDF coordinate transformation to canvas viewport zoom/pan transforms.
3. Overhaul character hit testing to implement exact continuous glyph-level range selection with precise visual feedback.
