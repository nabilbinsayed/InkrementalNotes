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
    this.activeTouches = new Map();
    this.isPinching = false;
    this.gestureOccurred = false;
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

  getVisiblePages(pane = 'left', margin = 300) {
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
    // toggleSplitMode is a discrete UI action — fire onChange immediately (not RAF-coalesced)
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

  clampPanX(x, pane = 'left') {
    if (!this.maxDocWidth || !this.stageRect) return x;
    const isRight = pane === 'right' && this.splitMode;
    const z = isRight ? this.rightZoom : this.zoom;
    const totalW = this.stageRect ? this.stageRect.width : 800;
    const stageW = this.splitMode ? totalW / 2 : totalW;
    const docW = this.maxDocWidth * z;
    const hMargin = Math.max(80, stageW * 0.15);
    const offsetLeft = isRight ? stageW : 0;

    if (docW + 2 * hMargin <= stageW) {
      // Document fits horizontally with margin: clamp around centered position
      const centerX = offsetLeft + (stageW - docW) / 2;
      return Math.max(centerX - hMargin, Math.min(centerX + hMargin, x));
    }

    const minPanX = offsetLeft + stageW - docW - hMargin;
    const maxPanX = offsetLeft + hMargin;
    return Math.max(minPanX, Math.min(maxPanX, x));
  }

  setPan(x, y, pane = 'left') {
    const clampedY = this.clampPanY(y, pane);
    const clampedX = this.clampPanX(x, pane);
    if (pane === 'right' && this.splitMode) {
      this.rightPanX = clampedX;
      this.rightPanY = clampedY;
    } else {
      this.panX = clampedX;
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
        this.rightZoom = newZoom;
        this.rightPanX = this.clampPanX(newPanX, 'right');
        this.rightPanY = this.clampPanY(newPanY, 'right');
      } else {
        this.zoom = newZoom;
        this.panX = this.clampPanX(newPanX, 'left');
        this.panY = this.clampPanY(newPanY, 'left');
      }
    } else {
      if (isRight) {
        this.rightZoom = newZoom;
        this.rightPanX = this.clampPanX(this.rightPanX, 'right');
        this.rightPanY = this.clampPanY(this.rightPanY, 'right');
      } else {
        this.zoom = newZoom;
        this.panX = this.clampPanX(this.panX, 'left');
        this.panY = this.clampPanY(this.panY, 'left');
      }
    }
    if (this.onChange) this.onChange();
    if (typeof window !== 'undefined' && typeof window.emitZoomChanged === 'function') {
      window.emitZoomChanged(this);
    }
  }

  zoomIn(centerPx = null, pane = 'left') {
    const cur = (pane === 'right' && this.splitMode) ? this.rightZoom : this.zoom;
    this.setZoom(Math.min(10.0, cur * 1.25), centerPx, pane);
  }

  zoomOut(centerPx = null, pane = 'left') {
    const cur = (pane === 'right' && this.splitMode) ? this.rightZoom : this.zoom;
    this.setZoom(Math.max(0.15, cur / 1.25), centerPx, pane);
  }

  get stageW() { return this.stageRect ? this.stageRect.width : 800; }
  get stageH() { return this.stageRect ? this.stageRect.height : 600; }

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
  fitWidth(pageWidthPt, pane = 'left') {
    const docW = this.maxDocWidth || pageWidthPt || 595.0;
    if (!this.stageRect) this.updateStageRect();
    const totalW = this.stageRect ? this.stageRect.width : 800;
    const stageW = this.splitMode ? totalW / 2 : totalW;
    const margin = 48;
    const availW = Math.max(100, stageW - margin);
    const fitZoom = Math.max(0.2, Math.min(6.0, availW / docW));
    this.setZoom(fitZoom, null, pane);
    this.centerDocument(docW, null, pane);
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
    this.stageElement = element;
    this.updateStageRect();
    window.addEventListener('resize', () => this.updateStageRect());
    window.addEventListener('scroll', () => this.updateStageRect(), { passive: true });
    if (typeof ResizeObserver !== 'undefined' && element) {
      new ResizeObserver(() => this.updateStageRect()).observe(element);
    }

    const onWheel = e => {
      // Allow native scroll inside explicit scrollable dialogs/drawers
      if (e.target && e.target.closest && e.target.closest('.drawer-body, .settings-modal-body, .cmd-palette-list, .zoom-menu-options, .recent-files-list, #outlineList, #searchResultList, #bookmarksList')) {
        return;
      }

      if (!this.stageRect) this.updateStageRect();
      const stageRect = this.stageRect || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const relX = e.clientX - stageRect.left;
      const relY = e.clientY - stageRect.top;
      const pane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';
      this.activePane = pane;
      if (typeof window !== 'undefined' && window.state) {
        window.state.activePane = pane;
      }

      // NOTE [UNSOLVED]: On Windows WebView2, precision touchpad pinch gestures are
      // handled/intercepted by DirectManipulation at the webview host level and may not
      // dispatch WheelEvent(ctrlKey) to the DOM. Kept here as fallback when delivered.
      // Chromium reports a precision-touchpad pinch as a Ctrl+wheel event;
      // Command covers the equivalent gesture on macOS.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Continuous smooth exponential zoom for touchpad pinch & Ctrl+wheel.
        // e.deltaMode: 0 = pixel (precision touchpad pinch), 1 = line (mouse wheel), 2 = page
        const scaleFactor = e.deltaMode === 1 ? 0.06 : (e.deltaMode === 2 ? 0.6 : 0.015);
        const zoomFactor = Math.exp(-e.deltaY * scaleFactor);
        const curZoom = pane === 'right' ? this.rightZoom : this.zoom;
        const newZoom = Math.max(0.15, Math.min(10.0, curZoom * zoomFactor));
        this.setZoom(newZoom, [relX, relY], pane);
        return;
      } else {
        e.preventDefault();
        let dx = e.deltaX;
        let dy = e.deltaY;
        if (e.shiftKey && !dx && dy) {
          dx = dy;
          dy = 0;
        }
        if (e.deltaMode === 1) { // DOM_DELTA_LINE on standard mouse wheel (e.g. 3 lines -> 120px)
          dx *= 40;
          dy *= 40;
        } else if (e.deltaMode === 2) { // DOM_DELTA_PAGE
          dx *= 600;
          dy *= 600;
        }
        const curPanX = pane === 'right' ? this.rightPanX : this.panX;
        const curPanY = pane === 'right' ? this.rightPanY : this.panY;
        this.setPan(curPanX - dx, curPanY - dy, pane);
      }
    };

    window.addEventListener('wheel', onWheel, { passive: false });



    // Safari / WebKit native trackpad pinch-to-zoom support

    let gestureStartZoom = 1.0;

    const onGestureStart = e => {

      e.preventDefault();

      if (!this.stageRect) this.updateStageRect();

      const stageRect = this.stageRect || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

      const relX = e.clientX - stageRect.left;

      const pane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';

      gestureStartZoom = pane === 'right' ? this.rightZoom : this.zoom;

    };

    const onGestureChange = e => {

      e.preventDefault();

      if (!this.stageRect) this.updateStageRect();

      const stageRect = this.stageRect || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

      const relX = e.clientX - stageRect.left;

      const pane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';

      const newZoom = Math.max(0.15, Math.min(10.0, gestureStartZoom * (e.scale || 1.0)));

      this.setZoom(newZoom, [relX, relY], pane);

    };

    const onGestureEnd = e => {

      e.preventDefault();

    };



    window.addEventListener('gesturestart', onGestureStart, { passive: false });

    window.addEventListener('gesturechange', onGestureChange, { passive: false });

    window.addEventListener('gestureend', onGestureEnd, { passive: false });

    // ---- Multi-touch gesture handling via Pointer Events ----
    const onPointerDownGlobal = e => {
      if (!this.stageRect) this.updateStageRect();
      const stageRect = this.stageRect || { left: 0, top: 0, width: 1000 };
      const relX = e.clientX - stageRect.left;
      const pane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';
      this.activePane = pane;
      if (typeof window !== 'undefined' && window.state) {
        window.state.activePane = pane;
      }

      if (e.pointerType === 'pen') {
        this.isStylusActive = true;
      }
      if (e.pointerType === 'touch') {
        this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.activeTouches.size >= 2) {
          this.isPinching = true;
          this.gestureOccurred = true;
          if (typeof window !== 'undefined' && typeof window.cancelPendingTouchStroke === 'function') {
            window.cancelPendingTouchStroke();
          }
          const pts = Array.from(this.activeTouches.values());
          const dx = pts[1].x - pts[0].x;
          const dy = pts[1].y - pts[0].y;
          this.pinchStartDist = Math.hypot(dx, dy) || 1;
          this.pinchStartMid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
          this.pinchStartZoom = pane === 'right' ? this.rightZoom : this.zoom;
          this.pinchStartPan = pane === 'right' ? [this.rightPanX, this.rightPanY] : [this.panX, this.panY];
        }
      }
      if (e.button === 1) { // middle button only
        e.preventDefault();
        this.isPanning = true;
        this.lastPanPt = [e.clientX, e.clientY];
        if (element) {
          try { element.setPointerCapture(e.pointerId); } catch (_) {}
        }
      }
    };

    const onPointerMoveGlobal = e => {
      if (e.pointerType === 'touch' && this.activeTouches.has(e.pointerId)) {
        this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.activeTouches.size >= 2 && this.pinchStartDist && this.pinchStartMid && this.pinchStartPan) {
          e.preventDefault();
          this.isPinching = true;
          this.gestureOccurred = true;
          const pts = Array.from(this.activeTouches.values());
          const curDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
          const curMid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
          const scale = curDist / this.pinchStartDist;
          const newZoom = Math.max(0.15, Math.min(10.0, this.pinchStartZoom * scale));
          const stageRect = this.stageRect || { left: 0, top: 0 };

          const pane = this.activePane;
          const startMidX = this.pinchStartMid[0] - stageRect.left;
          const startMidY = this.pinchStartMid[1] - stageRect.top;
          const curMidX = curMid[0] - stageRect.left;
          const curMidY = curMid[1] - stageRect.top;

          // World coordinate of initial touch midpoint
          const worldX = (startMidX - this.pinchStartPan[0]) / this.pinchStartZoom;
          const worldY = (startMidY - this.pinchStartPan[1]) / this.pinchStartZoom;

          // Compute new pan so world point stays locked under curMid
          const targetPanX = curMidX - worldX * newZoom;
          const targetPanY = curMidY - worldY * newZoom;

          if (pane === 'right' && this.splitMode) {
            this.rightZoom = newZoom;
            this.rightPanX = this.clampPanX(targetPanX, 'right');
            this.rightPanY = this.clampPanY(targetPanY, 'right');
          } else {
            this.zoom = newZoom;
            this.panX = this.clampPanX(targetPanX, 'left');
            this.panY = this.clampPanY(targetPanY, 'left');
          }
          if (this.onChange) this.onChange();
          if (typeof window !== 'undefined' && typeof window.emitZoomChanged === 'function') {
            window.emitZoomChanged(this);
          }
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
    };

    const onPointerEnd = e => {
      if (e.pointerType === 'pen') {
        this.isStylusActive = false;
      }
      if (e.pointerType === 'touch') {
        this.activeTouches.delete(e.pointerId);
        if (this.activeTouches.size < 2) {
          this.isPinching = false;
          this.pinchStartDist = null;
          this.pinchStartZoom = null;
          this.pinchStartMid = null;
          this.pinchStartPan = null;
        }
        if (this.activeTouches.size === 0) {
          this.gestureOccurred = false;
        }
      }
      if (e.button === 1) {
        this.isPanning = false;
        if (element) {
          try { element.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      }
    };

    window.addEventListener('pointerdown', onPointerDownGlobal, { capture: true, passive: false });
    // Capture the movement before the drawing canvas handles it. This is
    // essential when the first finger began an ink stroke before the second
    // finger turned the interaction into a pinch.
    window.addEventListener('pointermove', onPointerMoveGlobal, { capture: true, passive: false });
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);

  }
}

window.ViewportManager = ViewportManager;

