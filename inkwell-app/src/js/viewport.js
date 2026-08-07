/* ============================================================================
 * viewport.js — Viewport pan/zoom management
 * ========================================================================== */

class ViewportManager {
  constructor(onChange) {
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1.0;
    this.rightPanX = 0;
    this.rightPanY = 0;
    this.rightZoom = 1.0;
    this.splitMode = false;
    this.activePane = 'left';
    this.onChange = onChange;
    this.isPanning = false;
    this.lastPanPt = [0, 0];
  }

  toggleSplitMode() {
    this.splitMode = !this.splitMode;
    if (this.splitMode) {
      this.rightPanX = this.panX;
      this.rightPanY = this.panY;
      this.rightZoom = this.zoom;
    }
    if (this.onChange) this.onChange();
    return this.splitMode;
  }

  setPan(x, y, pane = 'left') {
    if (pane === 'right' && this.splitMode) {
      this.rightPanX = x;
      this.rightPanY = y;
    } else {
      this.panX = x;
      this.panY = y;
    }
    if (this.onChange) this.onChange();
  }

  setZoom(z, centerPx = null, pane = 'left') {
    const isRight = pane === 'right' && this.splitMode;
    const curZoom = isRight ? this.rightZoom : this.zoom;
    const curPanX = isRight ? this.rightPanX : this.panX;
    const curPanY = isRight ? this.rightPanY : this.panY;

    const newZoom = Math.max(0.2, Math.min(16.0, z));
    if (centerPx && curZoom !== newZoom) {
      const scale = newZoom / curZoom;
      const newPanX = centerPx[0] - (centerPx[0] - curPanX) * scale;
      const newPanY = centerPx[1] - (centerPx[1] - curPanY) * scale;
      if (isRight) {
        this.rightPanX = newPanX;
        this.rightPanY = newPanY;
        this.rightZoom = newZoom;
      } else {
        this.panX = newPanX;
        this.panY = newPanY;
        this.zoom = newZoom;
      }
    } else {
      if (isRight) this.rightZoom = newZoom;
      else this.zoom = newZoom;
    }
    if (this.onChange) this.onChange();
  }

  screenToWorld(sx, sy, pane = 'left') {
    const isRight = pane === 'right' && this.splitMode;
    const z = isRight ? this.rightZoom : this.zoom;
    const px = isRight ? this.rightPanX : this.panX;
    const py = isRight ? this.rightPanY : this.panY;
    return [
      (sx - px) / z,
      (sy - py) / z
    ];
  }

  worldToScreen(wx, wy, pane = 'left') {
    const isRight = pane === 'right' && this.splitMode;
    const z = isRight ? this.rightZoom : this.zoom;
    const px = isRight ? this.rightPanX : this.panX;
    const py = isRight ? this.rightPanY : this.panY;
    return [
      wx * z + px,
      wy * z + py
    ];
  }

  attachListeners(element) {
    element.addEventListener('wheel', e => {
      const stageRect = element.getBoundingClientRect();
      const relX = e.clientX - stageRect.left;
      const relY = e.clientY - stageRect.top;
      const pane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';
      this.activePane = pane;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const curZoom = pane === 'right' ? this.rightZoom : this.zoom;
        this.setZoom(curZoom * factor, [relX, relY], pane);
      } else {
        e.preventDefault();
        const curPanX = pane === 'right' ? this.rightPanX : this.panX;
        const curPanY = pane === 'right' ? this.rightPanY : this.panY;
        this.setPan(curPanX - e.deltaX, curPanY - e.deltaY, pane);
      }
    }, { passive: false });
  }
}

window.ViewportManager = ViewportManager;
