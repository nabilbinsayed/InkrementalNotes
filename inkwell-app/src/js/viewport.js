/* ============================================================================
 * viewport.js — Viewport pan/zoom and continuous document layout management
 * ========================================================================== */

const PAGE_GAP = 24.0; // gap in points between consecutive pages in continuous scroll

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
    this.isStylusActive = false;
    this.activeTouches = new Map();
    this.pinchStartDist = null;
    this.pinchStartZoom = null;
    this.pinchStartMid = null;

    // Document multi-page continuous layout state
    this.pageLayouts = []; // array of { sheet, x, y, width, height }
    this.maxDocWidth = 595.0;
    this.totalDocHeight = 842.0;
  }

  updateStageRect() {
    if (this.element) {
      this.stageRect = this.element.getBoundingClientRect();
    }
  }

  updateDocumentLayout(pageInfos) {
    if (!pageInfos || !pageInfos.length) {
      this.pageLayouts = [];
      this.maxDocWidth = 595.0;
      this.totalDocHeight = 842.0;
      return;
    }

    let maxW = 0;
    for (const pi of pageInfos) {
      if (pi.width_pt > maxW) maxW = pi.width_pt;
    }
    if (maxW <= 0) maxW = 595.0;
    this.maxDocWidth = maxW;

    let curY = 0;
    const layouts = [];
    for (let i = 0; i < pageInfos.length; i++) {
      const pi = pageInfos[i];
      const w = pi.width_pt || 595.0;
      const h = pi.height_pt || 842.0;
      const x = (maxW - w) / 2;
      layouts.push({
        sheet: i,
        x,
        y: curY,
        width: w,
        height: h,
      });
      curY += h + PAGE_GAP;
    }
    this.pageLayouts = layouts;
    this.totalDocHeight = Math.max(curY - PAGE_GAP, 100);
  }

  getPageLayout(sheetIndex) {
    if (this.pageLayouts && this.pageLayouts[sheetIndex]) {
      return this.pageLayouts[sheetIndex];
    }
    return { sheet: sheetIndex, x: 0, y: 0, width: 595.0, height: 842.0 };
  }

  pageToWorld(sheetIndex, px, py) {
    const layout = this.getPageLayout(sheetIndex);
    return [px + layout.x, py + layout.y];
  }

  worldToPage(wx, wy) {
    if (!this.pageLayouts || !this.pageLayouts.length) {
      return { sheet: 0, px: wx, py: wy };
    }
    // Find page whose y bounds enclose wy
    for (let i = 0; i < this.pageLayouts.length; i++) {
      const pl = this.pageLayouts[i];
      if (wy >= pl.y && wy <= pl.y + pl.height + PAGE_GAP) {
        return {
          sheet: i,
          px: wx - pl.x,
          py: Math.max(0, Math.min(pl.height, wy - pl.y)),
        };
      }
    }
    // If above first page
    if (wy < this.pageLayouts[0].y) {
      const pl = this.pageLayouts[0];
      return { sheet: 0, px: wx - pl.x, py: wy - pl.y };
    }
    // If below last page
    const last = this.pageLayouts[this.pageLayouts.length - 1];
    return { sheet: last.sheet, px: wx - last.x, py: wy - last.y };
  }

  getVisiblePages(pane = 'left', margin = 40) {
    if (!this.pageLayouts || !this.pageLayouts.length) return [];
    if (!this.stageRect) this.updateStageRect();
    const stageH = this.stageRect ? this.stageRect.height : 600;
    const stageW = this.stageRect ? this.stageRect.width : 800;
    const w = this.splitMode ? stageW / 2 : stageW;

    const [, topWy] = this.screenToWorld(0, -margin, pane);
    const [, bottomWy] = this.screenToWorld(0, stageH + margin, pane);
    const minWy = Math.min(topWy, bottomWy);
    const maxWy = Math.max(topWy, bottomWy);

    return this.pageLayouts.filter(pl => {
      const pageTop = pl.y;
      const pageBottom = pl.y + pl.height;
      return pageBottom >= minWy && pageTop <= maxWy;
    });
  }

  getActivePageInView(pane = 'left') {
    if (!this.pageLayouts || !this.pageLayouts.length) return 0;
    if (!this.stageRect) this.updateStageRect();
    const stageH = this.stageRect ? this.stageRect.height : 600;
    const centerY = stageH * 0.35; // upper third center of viewport
    const [, centerWy] = this.screenToWorld(0, centerY, pane);

    for (let i = 0; i < this.pageLayouts.length; i++) {
      const pl = this.pageLayouts[i];
      if (centerWy >= pl.y && centerWy <= pl.y + pl.height + PAGE_GAP) {
        return i;
      }
    }
    if (centerWy < this.pageLayouts[0].y) return 0;
    return this.pageLayouts.length - 1;
  }

  toggleSplitMode() {
    this.splitMode = !this.splitMode;
    if (this.splitMode) {
      if (!this.stageRect) this.updateStageRect();
      const totalW = this.stageRect ? this.stageRect.width : 800;
      const halfW = totalW / 2;
      this.rightZoom = this.zoom;
      this.rightPanX = this.panX + halfW;
      this.rightPanY = this.panY;
    }
    if (this.onChange) this.onChange();
    return this.splitMode;
  }

  clampPanY(y, pane = 'left') {
    if (!this.totalDocHeight || !this.pageLayouts || !this.pageLayouts.length) return y;
    if (!this.stageRect) this.updateStageRect();
    const stageH = this.stageRect ? this.stageRect.height : 600;
    const isRight = pane === 'right' && this.splitMode;
    const z = isRight ? this.rightZoom : this.zoom;
    const totalH = this.totalDocHeight * z;
    const topMargin = 40;
    const bottomMargin = 80;

    // Top boundary: Cannot pan below topMargin (first page top)
    const maxPanY = topMargin;

    // Bottom boundary:
    // If total document height is smaller than stage: pin top at topMargin
    // If document is taller than stage: bottom of last page cannot go above stageH - bottomMargin
    const minPanY = totalH < stageH
      ? topMargin
      : stageH - totalH - bottomMargin;

    return Math.max(minPanY, Math.min(maxPanY, y));
  }

  setPan(x, y, pane = 'left') {
    const clampedY = this.clampPanY(y, pane);
    if (pane === 'right' && this.splitMode) {
      this.rightPanX = x;
      this.rightPanY = clampedY;
    } else {
      this.panX = x;
      this.panY = clampedY;
    }
    if (this.onChange) this.onChange();
  }

  setZoom(z, centerPx = null, pane = 'left') {
    const isRight = pane === 'right' && this.splitMode;
    const curZoom = isRight ? this.rightZoom : this.zoom;
    const curPanX = isRight ? this.rightPanX : this.panX;
    const curPanY = isRight ? this.rightPanY : this.panY;

    const newZoom = Math.max(0.1, Math.min(16.0, z));
    if (centerPx && curZoom !== newZoom) {
      const scale = newZoom / curZoom;
      const newPanX = centerPx[0] - (centerPx[0] - curPanX) * scale;
      const newPanY = centerPx[1] - (centerPx[1] - curPanY) * scale;
      if (isRight) {
        this.rightPanX = newPanX;
        this.rightPanY = this.clampPanY(newPanY, 'right');
        this.rightZoom = newZoom;
      } else {
        this.panX = newPanX;
        this.panY = this.clampPanY(newPanY, 'left');
        this.zoom = newZoom;
      }
    } else {
      if (isRight) {
        this.rightZoom = newZoom;
        this.rightPanY = this.clampPanY(this.rightPanY, 'right');
      } else {
        this.zoom = newZoom;
        this.panY = this.clampPanY(this.panY, 'left');
      }
    }
    if (this.onChange) this.onChange();
  }

  centerDocument(pageWidthPt, pageHeightPt, pane = 'left') {
    const docW = this.maxDocWidth || pageWidthPt || 595.0;
    if (!this.stageRect) this.updateStageRect();
    const isRight = pane === 'right' && this.splitMode;
    const z = isRight ? this.rightZoom : this.zoom;
    const totalW = this.stageRect ? this.stageRect.width : 800;
    const stageW = this.splitMode ? totalW / 2 : totalW;

    const offsetLeft = isRight ? stageW : 0;
    const targetPanX = Math.round(offsetLeft + (stageW - docW * z) / 2);
    const targetPanY = 30;
    this.setPan(targetPanX, targetPanY, pane);
  }

  fitPage(pageWidthPt, pageHeightPt, pane = 'left') {
    const docW = this.maxDocWidth || pageWidthPt || 595.0;
    const firstH = (this.pageLayouts && this.pageLayouts[0]) ? this.pageLayouts[0].height : (pageHeightPt || 842.0);
    if (!this.stageRect) this.updateStageRect();
    const totalW = this.stageRect ? this.stageRect.width : 800;
    const stageW = this.splitMode ? totalW / 2 : totalW;
    const stageH = this.stageRect ? this.stageRect.height : 600;

    const margin = 48;
    const availW = Math.max(100, stageW - margin);
    const availH = Math.max(100, stageH - margin);

    const fitZoom = Math.max(0.2, Math.min(4.0, Math.min(availW / docW, availH / firstH)));
    this.setZoom(fitZoom, null, pane);
    this.centerDocument(docW, firstH, pane);
  }

  scrollToPage(sheetIndex, pane = 'left') {
    const layout = this.getPageLayout(sheetIndex);
    if (!layout) return;
    const isRight = pane === 'right' && this.splitMode;
    const z = isRight ? this.rightZoom : this.zoom;
    const curPanX = isRight ? this.rightPanX : this.panX;

    const targetPanY = Math.round(-layout.y * z + 30);
    this.setPan(curPanX, targetPanY, pane);
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
    if (typeof ResizeObserver !== 'undefined' && element) {
      new ResizeObserver(() => this.updateStageRect()).observe(element);
    }

    let wheelAccumX = 0;
    let wheelAccumY = 0;
    let wheelRaf = null;

    element.addEventListener('wheel', e => {
      if (!this.stageRect) this.updateStageRect();
      const stageRect = this.stageRect;
      const relX = e.clientX - stageRect.left;
      const relY = e.clientY - stageRect.top;
      const pane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';
      this.activePane = pane;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.08 : 0.92;
        const curZoom = pane === 'right' ? this.rightZoom : this.zoom;
        this.setZoom(curZoom * factor, [relX, relY], pane);
      } else {
        e.preventDefault();
        wheelAccumX -= e.deltaX;
        wheelAccumY -= e.deltaY;
        if (!wheelRaf) {
          wheelRaf = requestAnimationFrame(() => {
            wheelRaf = null;
            const curPanX = pane === 'right' ? this.rightPanX : this.panX;
            const curPanY = pane === 'right' ? this.rightPanY : this.panY;
            this.setPan(curPanX + wheelAccumX, curPanY + wheelAccumY, pane);
            wheelAccumX = 0;
            wheelAccumY = 0;
          });
        }
      }
    }, { passive: false });

    element.addEventListener('pointerdown', e => {
      if (e.pointerType === 'pen') {
        this.isStylusActive = true;
      }
      if (e.pointerType === 'touch') {
        this.touchStartTimes = this.touchStartTimes || new Map();
        this.touchStartTimes.set(e.pointerId, { t: Date.now(), x: e.clientX, y: e.clientY });
        this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.activeTouches.size === 2) {
          const pts = Array.from(this.activeTouches.values());
          const dx = pts[1].x - pts[0].x;
          const dy = pts[1].y - pts[0].y;
          this.pinchStartDist = Math.hypot(dx, dy) || 1;
          this.pinchStartMid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
          if (!this.stageRect) this.updateStageRect();
          const stageRect = this.stageRect || { left: 0, top: 0, width: 1000 };
          const relX = this.pinchStartMid[0] - stageRect.left;
          const pane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';
          this.activePane = pane;
          this.pinchStartZoom = pane === 'right' ? this.rightZoom : this.zoom;
        }
      }
      if (e.button === 1) { // middle button only
        e.preventDefault();
        if (!this.stageRect) this.updateStageRect();
        const stageRect = this.stageRect;
        const relX = e.clientX - stageRect.left;
        this.isPanning = true;
        this.lastPanPt = [e.clientX, e.clientY];
        this.activePane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';
        try { element.setPointerCapture(e.pointerId); } catch (_) {}
      }
    });

    element.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch' && this.activeTouches.has(e.pointerId)) {
        this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.activeTouches.size === 2 && this.pinchStartDist && this.pinchStartMid) {
          e.preventDefault();
          const pts = Array.from(this.activeTouches.values());
          const curDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
          const curMid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
          const scale = curDist / this.pinchStartDist;
          const newZoom = this.pinchStartZoom * scale;
          const stageRect = this.stageRect || { left: 0, top: 0 };
          const pivot = [this.pinchStartMid[0] - stageRect.left, this.pinchStartMid[1] - stageRect.top];
          this.setZoom(newZoom, pivot, this.activePane);

          const dMidX = curMid[0] - this.pinchStartMid[0];
          const dMidY = curMid[1] - this.pinchStartMid[1];
          if (Math.hypot(dMidX, dMidY) > 2) {
            const pane = this.activePane;
            const curPanX = pane === 'right' ? this.rightPanX : this.panX;
            const curPanY = pane === 'right' ? this.rightPanY : this.panY;
            this.setPan(curPanX + dMidX * 0.5, curPanY + dMidY * 0.5, pane);
            this.pinchStartMid = curMid;
          }
          if (typeof window.scheduleRedrawTiles === 'function') window.scheduleRedrawTiles();
          if (typeof window.redrawAll === 'function') window.redrawAll();
          return;
        }
      }

      if (this.isPanning) {
        const dx = e.clientX - this.lastPanPt[0];
        const dy = e.clientY - this.lastPanPt[1];
        this.lastPanPt = [e.clientX, e.clientY];
        const pane = this.activePane;
        const curPanX = pane === 'right' ? this.rightPanX : this.panX;
        const curPanY = pane === 'right' ? this.rightPanY : this.panY;
        this.setPan(curPanX + dx, curPanY + dy, pane);
      }
    });

    const onPointerEnd = e => {
      if (e.pointerType === 'pen') {
        this.isStylusActive = false;
      }
      if (e.pointerType === 'touch') {
        const startInfo = this.touchStartTimes && this.touchStartTimes.get(e.pointerId);
        if (startInfo) {
          const dt = Date.now() - startInfo.t;
          const dist = Math.hypot(e.clientX - startInfo.x, e.clientY - startInfo.y);
          if (dt < 350 && dist < 15) {
            this.recentTapCount = (this.recentTapCount || 0) + 1;
            clearTimeout(this.tapTimer);
            this.tapTimer = setTimeout(() => {
              if (this.recentTapCount === 2) {
                if (typeof window.undo === 'function') window.undo();
                if (typeof window.showToast === 'function') window.showToast('Undo (2-finger tap)', 'info');
              } else if (this.recentTapCount === 3) {
                if (typeof window.redo === 'function') window.redo();
                if (typeof window.showToast === 'function') window.showToast('Redo (3-finger tap)', 'info');
              }
              this.recentTapCount = 0;
            }, 100);
          }
        }
        if (this.touchStartTimes) this.touchStartTimes.delete(e.pointerId);
        this.activeTouches.delete(e.pointerId);
        if (this.activeTouches.size < 2) {
          this.pinchStartDist = null;
          this.pinchStartZoom = null;
          this.pinchStartMid = null;
        }
      }
      if (e.button === 1) {
        this.isPanning = false;
        try { element.releasePointerCapture(e.pointerId); } catch (_) {}
      }
    };
    element.addEventListener('pointerup', onPointerEnd);
    element.addEventListener('pointercancel', onPointerEnd);
  }
}

window.ViewportManager = ViewportManager;

