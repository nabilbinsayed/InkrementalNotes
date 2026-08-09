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
    this.stageRect = null;
    this.element = null;
  }

  updateStageRect() {
    if (this.element) {
      this.stageRect = this.element.getBoundingClientRect();
    }
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

  centerDocument(pageWidthPt, pageHeightPt, pane = 'left') {
    if (!pageWidthPt || !pageHeightPt) return;
    if (!this.stageRect) this.updateStageRect();
    const isRight = pane === 'right' && this.splitMode;
    const z = isRight ? this.rightZoom : this.zoom;
    const stageW = this.splitMode ? (this.stageRect ? this.stageRect.width / 2 : 400) : (this.stageRect ? this.stageRect.width : 800);
    const stageH = this.stageRect ? this.stageRect.height : 600;

    const targetPanX = Math.round((stageW - pageWidthPt * z) / 2);
    const targetPanY = Math.max(20, Math.round((stageH - pageHeightPt * z) / 2));
    this.setPan(targetPanX, targetPanY, pane);
  }

  fitPage(pageWidthPt, pageHeightPt, pane = 'left') {
    if (!pageWidthPt || !pageHeightPt) return;
    if (!this.stageRect) this.updateStageRect();
    const stageW = this.splitMode ? (this.stageRect ? this.stageRect.width / 2 : 400) : (this.stageRect ? this.stageRect.width : 800);
    const stageH = this.stageRect ? this.stageRect.height : 600;

    const margin = 40;
    const availW = Math.max(100, stageW - margin);
    const availH = Math.max(100, stageH - margin);

    const fitZoom = Math.max(0.2, Math.min(4.0, Math.min(availW / pageWidthPt, availH / pageHeightPt)));
    this.setZoom(fitZoom, null, pane);
    this.centerDocument(pageWidthPt, pageHeightPt, pane);
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
    this.element = element;
    this.updateStageRect();
    window.addEventListener('resize', () => this.updateStageRect());
    window.addEventListener('scroll', () => this.updateStageRect(), { passive: true });

    element.addEventListener('wheel', e => {
      if (!this.stageRect) this.updateStageRect();
      const stageRect = this.stageRect;
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

    // Middle-mouse button panning
    element.addEventListener('pointerdown', e => {
      if (e.button !== 1) return; // middle button only
      e.preventDefault();
      if (!this.stageRect) this.updateStageRect();
      const stageRect = this.stageRect;
      const relX = e.clientX - stageRect.left;
      this.isPanning = true;
      this.lastPanPt = [e.clientX, e.clientY];
      this.activePane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';
      try { element.setPointerCapture(e.pointerId); } catch (_) {}
    });

    element.addEventListener('pointermove', e => {
      if (!this.isPanning) return;
      const dx = e.clientX - this.lastPanPt[0];
      const dy = e.clientY - this.lastPanPt[1];
      this.lastPanPt = [e.clientX, e.clientY];
      const pane = this.activePane;
      const curPanX = pane === 'right' ? this.rightPanX : this.panX;
      const curPanY = pane === 'right' ? this.rightPanY : this.panY;
      this.setPan(curPanX + dx, curPanY + dy, pane);
    });

    element.addEventListener('pointerup', e => {
      if (e.button !== 1) return;
      this.isPanning = false;
      try { element.releasePointerCapture(e.pointerId); } catch (_) {}
    });
  }
}

window.ViewportManager = ViewportManager;
