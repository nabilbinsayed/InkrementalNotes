/* ============================================================================
 * app.js — Inkwell production web app controller
 * ========================================================================== */

const $ = id => document.getElementById(id);

const state = {
  activeTool: 'pen', // 'pen', 'highlighter', 'eraser', 'lasso', 'ruler'
  color: [0.08, 0.09, 0.14],
  baseWidth: 3.2,
  strokes: [],       // {id, kind, rgb, baseWidth, points[], deleted}
  undoStack: [],
  redoStack: [],
  cur: null,
  dpr: 1,
  samplesCount: 0,
  isErasing: false,
  // lasso / ruler state
  lassoStart: null,
  lassoRect: null,
  rulerStart: null,
  rulerEnd: null,
};

let tilesCanvas, dryCanvas, wetCanvas;
let tctx, dctx, wctx;
let viewport;

function makeCtx(canvas) {
  return canvas.getContext('2d', { desynchronized: true, alpha: true });
}

function resize() {
  const host = $('stage');
  const r = host.getBoundingClientRect();
  state.dpr = Math.max(1, window.devicePixelRatio || 1);

  for (const c of [tilesCanvas, dryCanvas, wetCanvas]) {
    c.width = Math.round(r.width * state.dpr);
    c.height = Math.round(r.height * state.dpr);
    c.style.width = r.width + 'px';
    c.style.height = r.height + 'px';
  }

  tctx = makeCtx(tilesCanvas);
  dctx = makeCtx(dryCanvas);
  wctx = makeCtx(wetCanvas);

  for (const ctx of [tctx, dctx, wctx]) ctx.scale(state.dpr, state.dpr);
  redrawAll();
}

function redrawAll() {
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, dryCanvas.width, dryCanvas.height);
  dctx.scale(state.dpr, state.dpr);
  dctx.save();
  dctx.translate(viewport.panX, viewport.panY);
  dctx.scale(viewport.zoom, viewport.zoom);
  for (const s of state.strokes) {
    if (!s.deleted) Ink.drawStroke(dctx, s);
  }
  dctx.restore();
}

function clearWet() {
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.clearRect(0, 0, wetCanvas.width, wetCanvas.height);
  wctx.scale(state.dpr, state.dpr);
}

function localXY(e) {
  const r = wetCanvas.getBoundingClientRect();
  return viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top);
}

function consume(e) {
  if (!state.cur) return;
  const [x, y] = localXY(e);
  const p = e.pressure > 0 ? e.pressure : 0.5;
  const prev = state.cur.last;
  const pt = state.cur.push(x, y, p, e.timeStamp);
  if (!pt) return;
  state.samplesCount++;

  wctx.save();
  wctx.translate(viewport.panX, viewport.panY);
  wctx.scale(viewport.zoom, viewport.zoom);
  wctx.fillStyle = `rgb(${state.cur.rgb.map(v => Math.round(v * 255)).join(',')})`;
  if (state.cur.kind === 'highlighter') {
    wctx.globalCompositeOperation = 'multiply';
    wctx.globalAlpha = 0.5;
  }
  if (prev) Ink.drawSegment(wctx, prev, pt);
  else Ink.drawDot(wctx, pt);
  wctx.restore();
  updateStats(e.pointerType);
}

// ---- Eraser (stroke-erase by proximity) ----
function eraseStrokesAt(e) {
  const [wx, wy] = localXY(e);
  const radius = 10 / viewport.zoom;
  let erasedAny = false;

  for (const s of state.strokes) {
    if (s.deleted) continue;
    for (const pt of s.points) {
      if (Math.hypot(pt.x - wx, pt.y - wy) < radius + pt.w / 2) {
        s.deleted = true;
        erasedAny = true;
        break;
      }
    }
  }

  if (erasedAny) {
    redrawAll();
    if (window.__TAURI__) {
      window.__TAURI__.core.invoke('erase_strokes_near', {
        sheet: 0, px: wx, py: wy, radius,
      }).catch(err => console.warn('erase_strokes_near failed:', err));
    }
  }
}

// ---- Lasso rect erase overlay ----
function drawLassoOverlay() {
  if (!state.lassoRect) return;
  const { x0, y0, x1, y1 } = state.lassoRect;
  const [sx0, sy0] = viewport.worldToScreen(x0, y0);
  const [sx1, sy1] = viewport.worldToScreen(x1, y1);
  wctx.save();
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.scale(state.dpr, state.dpr);
  wctx.strokeStyle = 'rgba(239,68,68,0.8)';
  wctx.fillStyle = 'rgba(239,68,68,0.08)';
  wctx.lineWidth = 1.5;
  wctx.setLineDash([4, 4]);
  wctx.beginPath();
  wctx.rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  wctx.fill();
  wctx.stroke();
  wctx.restore();
}

// ---- Ruler overlay ----
function drawRulerOverlay() {
  if (!state.rulerStart || !state.rulerEnd) return;
  const [sx0, sy0] = viewport.worldToScreen(state.rulerStart[0], state.rulerStart[1]);
  const [sx1, sy1] = viewport.worldToScreen(state.rulerEnd[0], state.rulerEnd[1]);
  wctx.save();
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.scale(state.dpr, state.dpr);
  wctx.strokeStyle = 'rgba(99,102,241,0.9)';
  wctx.lineWidth = 1.5;
  wctx.setLineDash([6, 3]);
  wctx.beginPath();
  wctx.moveTo(sx0, sy0);
  wctx.lineTo(sx1, sy1);
  wctx.stroke();
  const dx = state.rulerEnd[0] - state.rulerStart[0];
  const dy = state.rulerEnd[1] - state.rulerStart[1];
  const dist = Math.hypot(dx, dy).toFixed(1);
  wctx.font = '11px system-ui';
  wctx.fillStyle = 'rgba(99,102,241,1)';
  wctx.fillText(`${dist} pt`, (sx0 + sx1) / 2 + 6, (sy0 + sy1) / 2 - 4);
  wctx.restore();
}

// ---- Pointer handlers ----
function onDown(e) {
  if (e.button !== 0 && e.pointerType !== 'pen') return;
  try { wetCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  $('toolbar').classList.add('pen-down');

  const [wx, wy] = localXY(e);

  if (state.activeTool === 'eraser') {
    state.isErasing = true;
    eraseStrokesAt(e);
    return;
  }

  if (state.activeTool === 'lasso') {
    state.lassoStart = [wx, wy];
    state.lassoRect = { x0: wx, y0: wy, x1: wx, y1: wy };
    return;
  }

  if (state.activeTool === 'ruler') {
    state.rulerStart = [wx, wy];
    state.rulerEnd = [wx, wy];
    return;
  }

  const isHighlighter = state.activeTool === 'highlighter';
  state.cur = new Ink.Stroke({
    kind: state.activeTool,
    rgb: state.color,
    baseWidth: isHighlighter ? 12.0 : state.baseWidth,
  });
  consume(e);
  e.preventDefault();
}

function onMove(e) {
  const [wx, wy] = localXY(e);

  if (state.isErasing) { eraseStrokesAt(e); return; }

  if (state.activeTool === 'lasso' && state.lassoStart) {
    state.lassoRect = { x0: state.lassoStart[0], y0: state.lassoStart[1], x1: wx, y1: wy };
    clearWet();
    drawLassoOverlay();
    return;
  }

  if (state.activeTool === 'ruler' && state.rulerStart) {
    if (e.shiftKey) {
      const dx = wx - state.rulerStart[0], dy = wy - state.rulerStart[1];
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      state.rulerEnd = [state.rulerStart[0] + Math.cos(angle) * len,
                        state.rulerStart[1] + Math.sin(angle) * len];
    } else {
      state.rulerEnd = [wx, wy];
    }
    clearWet();
    drawRulerOverlay();
    return;
  }

  if (!state.cur) return;
  if (e.getCoalescedEvents) {
    const co = e.getCoalescedEvents();
    (co.length ? co : [e]).forEach(c => consume(c));
  } else {
    consume(e);
  }
  e.preventDefault();
}

async function onUp(e) {
  $('toolbar').classList.remove('pen-down');
  state.isErasing = false;

  // Lasso erase commit
  if (state.activeTool === 'lasso' && state.lassoRect) {
    const { x0, y0, x1, y1 } = state.lassoRect;
    const rx0 = Math.min(x0, x1), rx1 = Math.max(x0, x1);
    const ry0 = Math.min(y0, y1), ry1 = Math.max(y0, y1);
    let erasedAny = false;
    for (const s of state.strokes) {
      if (s.deleted) continue;
      if (s.points.some(pt => pt.x >= rx0 && pt.x <= rx1 && pt.y >= ry0 && pt.y <= ry1)) {
        s.deleted = true;
        erasedAny = true;
      }
    }
    state.lassoStart = null;
    state.lassoRect = null;
    clearWet();
    if (erasedAny) {
      redrawAll();
      if (window.__TAURI__) {
        window.__TAURI__.core.invoke('erase_strokes_in_rect', {
          sheet: 0, x0: rx0, y0: ry0, x1: rx1, y1: ry1,
        }).catch(err => console.warn('erase_strokes_in_rect failed:', err));
      }
    }
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  // Ruler: commit straight-line stroke
  if (state.activeTool === 'ruler' && state.rulerStart && state.rulerEnd) {
    const [ax, ay] = state.rulerStart, [bx, by] = state.rulerEnd;
    if (Math.hypot(bx - ax, by - ay) > 2) {
      const rulerStroke = new Ink.Stroke({ kind: 'pen', rgb: state.color, baseWidth: state.baseWidth });
      rulerStroke.push(ax, ay, 0.7, 0);
      rulerStroke.push(bx, by, 0.7, 50);
      state.strokes.push(rulerStroke);
      state.undoStack.push({ type: 'add', stroke: rulerStroke });
      state.redoStack = [];
      redrawAll();
      if (window.__TAURI__) {
        window.__TAURI__.core.invoke('commit_stroke', {
          sheet: 0, tool: 'pen', rgb: state.color, baseWidth: state.baseWidth,
          samples: [
            { x: ax, y: ay, pressure: 0.7, t_ms: 0 },
            { x: bx, y: by, pressure: 0.7, t_ms: 50 },
          ],
        }).catch(err => console.warn('ruler commit_stroke failed:', err));
      }
    }
    state.rulerStart = null;
    state.rulerEnd = null;
    clearWet();
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  if (!state.cur) return;

  const finishedStroke = state.cur;
  state.strokes.push(finishedStroke);
  state.undoStack.push({ type: 'add', stroke: finishedStroke });
  state.redoStack = [];

  if (window.__TAURI__) {
    try {
      const samplesPayload = finishedStroke.points.map(pt => ({
        x: pt.x, y: pt.y, pressure: pt.p || 0.5, t_ms: pt.t || 0,
      }));
      await window.__TAURI__.core.invoke('commit_stroke', {
        sheet: 0,
        tool: finishedStroke.kind,
        rgb: finishedStroke.rgb,
        baseWidth: finishedStroke.base_width,
        samples: samplesPayload,
      });
    } catch (err) { console.warn('Failed to commit stroke to Rust core:', err); }
  }

  redrawAll();
  state.cur = null;
  clearWet();
  try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
}

function updateStats(pointerType) {
  $('inputStats').innerHTML = `
    <div>Pointer: ${pointerType || 'pen'}</div>
    <div>Samples: ${state.samplesCount}</div>
    <div>Strokes: ${state.strokes.filter(s => !s.deleted).length}</div>
  `;
}

function bindUI() {
  const setTool = (tool, btnId) => {
    state.activeTool = tool;
    ['btnPen', 'btnHighlighter', 'btnEraser', 'btnLasso', 'btnRuler']
      .forEach(id => $(id) && $(id).classList.remove('active'));
    $(btnId) && $(btnId).classList.add('active');
  };

  $('btnPen').addEventListener('click', () => setTool('pen', 'btnPen'));
  $('btnHighlighter').addEventListener('click', () => setTool('highlighter', 'btnHighlighter'));
  $('btnEraser').addEventListener('click', () => setTool('eraser', 'btnEraser'));
  $('btnLasso') && $('btnLasso').addEventListener('click', () => setTool('lasso', 'btnLasso'));
  $('btnRuler') && $('btnRuler').addEventListener('click', () => setTool('ruler', 'btnRuler'));

  $('colorPicker').addEventListener('input', e => {
    const h = e.target.value;
    state.color = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255);
  });

  $('btnUndo').addEventListener('click', () => {
    if (!state.undoStack.length) return;
    const op = state.undoStack.pop();
    if (op.type === 'add') { op.stroke.deleted = true; state.redoStack.push(op); }
    redrawAll();
  });

  $('btnRedo').addEventListener('click', () => {
    if (!state.redoStack.length) return;
    const op = state.redoStack.pop();
    if (op.type === 'add') { op.stroke.deleted = false; state.undoStack.push(op); }
    redrawAll();
  });

  $('btnOpen').addEventListener('click', async () => {
    if (window.__TAURI__) {
      try {
        const selected = await window.__TAURI__.dialog.open({
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });
        if (selected) {
          const info = await window.__TAURI__.core.invoke('open_pdf', { pathStr: selected });
          $('docInfo').innerHTML = `
            <div>Loaded: ${selected.split('\\').pop()}</div>
            <div>Pages: ${info.length}</div>
          `;
        }
      } catch (err) { alert('Failed to open PDF: ' + err); }
    } else {
      alert('Running in browser mode. Open PDF via Tauri host.');
    }
  });

  $('btnSave').addEventListener('click', async () => {
    if (window.__TAURI__) {
      try {
        const savedPath = await window.__TAURI__.core.invoke('save_pdf', { outPathStr: null });
        alert('Saved annotations to: ' + savedPath);
      } catch (err) { alert('Failed to save PDF: ' + err); }
    } else {
      alert('Running in browser mode. Save via Tauri host.');
    }
  });

  // Keyboard shortcuts: P/H/E/L/R to switch tools
  window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const map = { p: ['pen', 'btnPen'], h: ['highlighter', 'btnHighlighter'],
                  e: ['eraser', 'btnEraser'], l: ['lasso', 'btnLasso'],
                  r: ['ruler', 'btnRuler'] };
    const pair = map[e.key.toLowerCase()];
    if (pair && $(pair[1])) setTool(pair[0], pair[1]);
  });
}

function attachPointerHandlers() {
  wetCanvas.addEventListener('pointerdown', onDown);
  const moveEvt = ('onpointerrawupdate' in window) ? 'pointerrawupdate' : 'pointermove';
  wetCanvas.addEventListener(moveEvt, onMove);
  wetCanvas.addEventListener('pointerup', onUp);
  wetCanvas.addEventListener('pointercancel', onUp);
  wetCanvas.addEventListener('contextmenu', e => e.preventDefault());
}

window.addEventListener('DOMContentLoaded', () => {
  tilesCanvas = $('tiles');
  dryCanvas = $('dry');
  wetCanvas = $('wet');

  viewport = new ViewportManager(() => redrawAll());
  viewport.attachListeners($('stage'));

  resize();
  attachPointerHandlers();
  bindUI();

  window.addEventListener('resize', resize);
});
