/* ============================================================================
 * app.js — Inkwell production web app controller
 * ========================================================================== */

const $ = id => document.getElementById(id);

const state = {
  activeTool: 'pen', // 'pen', 'highlighter', 'eraser'
  color: [0.08, 0.09, 0.14],
  baseWidth: 3.2,
  strokes: [],
  undoStack: [],
  redoStack: [],
  cur: null,
  dpr: 1,
  samplesCount: 0,
};

let tilesCanvas, dryCanvas, wetCanvas;
let tctx, dctx, wctx;
let viewport;

function makeCtx(canvas) {
  return canvas.getContext('2d', {
    desynchronized: true,
    alpha: true,
  });
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

  for (const ctx of [tctx, dctx, wctx]) {
    ctx.scale(state.dpr, state.dpr);
  }
  redrawAll();
}

function redrawAll() {
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, dryCanvas.width, dryCanvas.height);
  dctx.scale(state.dpr, state.dpr);

  // Apply viewport transform
  dctx.save();
  dctx.translate(viewport.panX, viewport.panY);
  dctx.scale(viewport.zoom, viewport.zoom);

  for (const s of state.strokes) {
    if (!s.deleted) {
      Ink.drawStroke(dctx, s);
    }
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
  const screenX = e.clientX - r.left;
  const screenY = e.clientY - r.top;
  // Convert screen coordinates to viewport-relative coordinates
  return viewport.screenToWorld(screenX, screenY);
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
  }
}

function onDown(e) {
  if (e.button !== 0 && e.pointerType !== 'pen') return;
  try { wetCanvas.setPointerCapture(e.pointerId); } catch (_) {}

  $('toolbar').classList.add('pen-down');

  if (state.activeTool === 'eraser') {
    state.isErasing = true;
    eraseStrokesAt(e);
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
  if (state.isErasing) {
    eraseStrokesAt(e);
    return;
  }

  if (!state.cur) return;

  if (e.getCoalescedEvents) {
    const co = e.getCoalescedEvents();
    if (co.length) {
      for (const c of co) consume(c);
    } else {
      consume(e);
    }
  } else {
    consume(e);
  }
  e.preventDefault();
}

function onUp(e) {
  $('toolbar').classList.remove('pen-down');
  state.isErasing = false;

  if (!state.cur) return;

  state.strokes.push(state.cur);
  state.undoStack.push({ type: 'add', stroke: state.cur });
  state.redoStack = [];

  // Redraw dry canvas
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
    ['btnPen', 'btnHighlighter', 'btnEraser'].forEach(id => $(id).classList.remove('active'));
    $(btnId).classList.add('active');
  };

  $('btnPen').addEventListener('click', () => setTool('pen', 'btnPen'));
  $('btnHighlighter').addEventListener('click', () => setTool('highlighter', 'btnHighlighter'));
  $('btnEraser').addEventListener('click', () => setTool('eraser', 'btnEraser'));

  $('colorPicker').addEventListener('input', e => {
    const h = e.target.value;
    state.color = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255);
  });

  $('btnUndo').addEventListener('click', () => {
    if (!state.undoStack.length) return;
    const op = state.undoStack.pop();
    if (op.type === 'add') {
      op.stroke.deleted = true;
      state.redoStack.push(op);
    }
    redrawAll();
  });

  $('btnRedo').addEventListener('click', () => {
    if (!state.redoStack.length) return;
    const op = state.redoStack.pop();
    if (op.type === 'add') {
      op.stroke.deleted = false;
      state.undoStack.push(op);
    }
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
      } catch (err) {
        alert("Failed to open PDF: " + err);
      }
    } else {
      alert("Running in browser mode. Open PDF via Tauri host.");
    }
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
