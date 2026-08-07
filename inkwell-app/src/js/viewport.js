/* ============================================================================
 * viewport.js — Viewport pan/zoom management
 * ========================================================================== */

class ViewportManager {
  constructor(onChange) {
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1.0;
    this.onChange = onChange;
    this.isPanning = false;
    this.lastPanPt = [0, 0];
  }

  setPan(x, y) {
    this.panX = x;
    this.panY = y;
    if (this.onChange) this.onChange();
  }

  setZoom(z, centerPx = null) {
    const oldZoom = this.zoom;
    this.zoom = Math.max(0.2, Math.min(16.0, z));
    if (centerPx && oldZoom !== this.zoom) {
      const scale = this.zoom / oldZoom;
      this.panX = centerPx[0] - (centerPx[0] - this.panX) * scale;
      this.panY = centerPx[1] - (centerPx[1] - this.panY) * scale;
    }
    if (this.onChange) this.onChange();
  }

  screenToWorld(sx, sy) {
    return [
      (sx - this.panX) / this.zoom,
      (sy - this.panY) / this.zoom
    ];
  }

  worldToScreen(wx, wy) {
    return [
      wx * this.zoom + this.panX,
      wy * this.zoom + this.panY
    ];
  }

  attachListeners(element) {
    element.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        this.setZoom(this.zoom * factor, [e.clientX, e.clientY]);
      } else {
        e.preventDefault();
        this.setPan(this.panX - e.deltaX, this.panY - e.deltaY);
      }
    }, { passive: false });
  }
}

window.ViewportManager = ViewportManager;
