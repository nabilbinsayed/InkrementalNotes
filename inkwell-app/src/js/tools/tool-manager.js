import { state, emit } from '../core/state.js';
import * as ipc from '../core/ipc.js';

export const TOOL_NAMES = [
  'pen', 'highlighter', 'eraser', 'lasso', 'ruler', 'rect', 'ellipse', 'laser', 'text', 'textSelect', 'pan'
];

// ---- Native Linux Evdev Hardware Stylus State ----
let liveNativePressure = 0.0;
let liveNativeDown = false;
let liveNativeTool = 'pen';
const activeStylusDevice = {
  name: 'Scanning...',
  path: '',
  minPressure: 0,
  maxPressure: 65535,
};

export function initStylusIntegration() {
  ipc.initNativeStylusStream((msg) => {
    if (!msg) return;
    if (msg.type === 'handshake') {
      const payload = msg.payload;
      if (payload) {
        activeStylusDevice.name = payload.device_name || 'Native Tablet';
        activeStylusDevice.path = payload.device_path || '';
        activeStylusDevice.minPressure = payload.pressure_min || 0;
        activeStylusDevice.maxPressure = payload.pressure_max || 65535;
        state.nativeDeviceInfo = `${activeStylusDevice.name} (${activeStylusDevice.path})`;
        emit('hardwareDiagnostics', {
          device: activeStylusDevice,
          pointerType: state.lastPointerType || 'pen',
          pressureSource: state.pressureSource || 'native',
          pressure: liveNativePressure,
        });
      }
    } else if (msg.type === 'sample') {
      const s = msg.payload;
      if (!s) return;
      liveNativePressure = s.pressure;
      liveNativeDown = s.down;
      liveNativeTool = s.tool === 2 ? 'eraser' : 'pen';
    }
  });
}

let _diagPending = false;
function scheduleDiagnostics(pointerType, source, pressure) {
  if (_diagPending) return;
  _diagPending = true;
  requestAnimationFrame(() => {
    _diagPending = false;
    emit('hardwareDiagnostics', {
      device: activeStylusDevice,
      pointerType,
      pressureSource: source,
      pressure,
    });
  });
}

export function resolvePressure(e) {
  if (liveNativeDown && liveNativePressure > 0.001) {
    state.pressureSource = 'native';
    state.lastPointerType = liveNativeTool;
    const p = Math.max(0.05, Math.min(1.0, liveNativePressure));
    scheduleDiagnostics(liveNativeTool, 'native', p);
    return p;
  }

  if (e && e.pointerType === 'pen' && e.pressure > 0) {
    state.pressureSource = 'browser';
    state.lastPointerType = 'pen';
    scheduleDiagnostics('pen', 'browser', e.pressure);
    return e.pressure;
  }

  state.pressureSource = 'fallback';
  state.lastPointerType = (e && e.pointerType) ? e.pointerType : 'mouse';
  scheduleDiagnostics(state.lastPointerType, 'fallback', 0.5);
  return 0.5;
}

if (typeof window !== 'undefined') {
  window.resolvePressure = resolvePressure;
}

export function getActiveTool() {
  return state.activeTool || 'pen';
}

export function setTool(toolName, { isUserSwitch = true } = {}) {
  if (!toolName) return;
  const canonical = TOOL_NAMES.find(t => t.toLowerCase() === String(toolName).toLowerCase()) || String(toolName).toLowerCase();
  const tool = canonical;
  
  if (isUserSwitch && tool !== 'pan' && state.activeTool && state.activeTool !== 'pan' && state.activeTool !== tool) {
    state.lastActiveTool = state.activeTool;
  }

  if (state.activeTool === 'lasso' && tool !== 'lasso') {
    state.selectedStrokes = [];
    state.selectedImages = [];
    state.selectedTextObjects = [];
    state.transformMode = null;
    state.lassoPath = null;
    emit('selectionCleared', {});
  }

  if ((state.activeTool === 'textSelect' || state.activeTool === 'textselect') && tool !== 'textSelect' && tool !== 'textselect') {
    state.textSelection = null;
    state.textSelectAnchor = null;
    state.textSelectPending = null;
    state.selectedTextSpans = [];
    state.selectedTextString = '';
    state.isSelectingText = false;
    const pop = typeof document !== 'undefined' ? document.getElementById('textSelectionPopover') : null;
    if (pop) pop.classList.add('hidden');
    emit('textSelectionCleared', {});
  }

  if (tool === 'ruler') {
    state.activeTool = 'ruler';
    state.shapeKind = 'line';
  } else if (tool === 'rect' || tool === 'ellipse') {
    state.activeTool = tool;
    state.shapeKind = tool;
  } else {
    state.activeTool = tool;
  }

  // Synchronise color and width properties according to tool
  if (state.activeTool === 'pen') {
    state.color = state.penColor || [0.08, 0.09, 0.14];
    state.baseWidth = state.penWidth || 1.6;
  } else if (state.activeTool === 'highlighter') {
    state.color = state.highlighterColor || [0.99, 0.93, 0.28];
    state.baseWidth = state.highlighterWidth || 16.0;
  } else if (state.activeTool === 'rect' || state.activeTool === 'ellipse' || state.activeTool === 'ruler') {
    state.color = state.shapesColor || [0.08, 0.09, 0.14];
    state.baseWidth = state.penWidth || 1.6;
  }

  const wet = typeof document !== 'undefined' ? document.getElementById('wet') : null;
  if (wet) {
    wet.className = '';
    wet.classList.add('tool-' + state.activeTool);
  }

  emit('toolChanged', { tool: state.activeTool, color: state.color, width: state.baseWidth });
}

export function setColor(rgbArray) {
  if (!Array.isArray(rgbArray) || rgbArray.length !== 3) return;
  state.color = rgbArray;
  if (state.activeTool === 'pen') state.penColor = rgbArray;
  else if (state.activeTool === 'highlighter') state.highlighterColor = rgbArray;
  else if (['rect', 'ellipse', 'ruler'].includes(state.activeTool)) state.shapesColor = rgbArray;

  emit('toolPropertyChanged', { property: 'color', value: rgbArray });
}

export function setWidth(widthPt) {
  const w = Math.max(0.2, Math.min(64, parseFloat(widthPt) || 1.6));
  state.baseWidth = w;
  if (state.activeTool === 'pen') state.penWidth = w;
  else if (state.activeTool === 'highlighter') state.highlighterWidth = w;

  emit('toolPropertyChanged', { property: 'width', value: w });
}

export function setShapeKind(kind) {
  if (['rect', 'ellipse', 'line'].includes(kind)) {
    state.shapeKind = kind;
    emit('toolPropertyChanged', { property: 'shapeKind', value: kind });
  }
}

export function handleSpaceKeyDown(e) {
  const isTyping = typeof document !== 'undefined' && document.activeElement && (
    document.activeElement.tagName === 'INPUT' ||
    document.activeElement.tagName === 'TEXTAREA' ||
    document.activeElement.isContentEditable
  );
  if (isTyping) return;
  if (state.isSpacePressed) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    return;
  }
  if (e && typeof e.preventDefault === 'function') e.preventDefault();

  state.isSpacePressed = true;
  state.spaceDownTime = performance.now();
  state.spaceToolBefore = state.activeTool || 'pen';
  state.spaceDidPan = false;

  setTool('pan', { isUserSwitch: false });
}

export function handleSpaceKeyUp(e) {
  if (!state.isSpacePressed) return;
  if (e && typeof e.preventDefault === 'function') e.preventDefault();

  const now = performance.now();
  const duration = state.spaceDownTime ? (now - state.spaceDownTime) : 0;
  const didPan = state.spaceDidPan;
  const toolBefore = state.spaceToolBefore || 'pen';

  if (duration < 250 && !didPan) {
    const target = (state.lastActiveTool && state.lastActiveTool !== toolBefore)
      ? state.lastActiveTool
      : (toolBefore === 'pen' ? 'eraser' : 'pen');
    state.lastActiveTool = toolBefore;
    setTool(target, { isUserSwitch: false });
  } else {
    setTool(toolBefore, { isUserSwitch: false });
  }

  state.isSpacePressed = false;
  state.spaceDownTime = null;
  state.spaceToolBefore = null;
  state.spaceDidPan = false;
}

let eDownTime = 0;
export function handleSpringKeyDown(key) {
  if (state.springKey) return;
  if (key === 'e' || key === 'E') {
    state.springKey = 'e';
    eDownTime = performance.now();
    state.prevTool = state.activeTool;
    setTool('eraser', { isUserSwitch: true });
  }
}

export function handleSpringKeyUp(key) {
  if (!state.springKey) return;
  if ((key === 'e' || key === 'E') && state.springKey === 'e') {
    state.springKey = null;
    const duration = performance.now() - eDownTime;
    // Only revert if held for longer than 350ms (momentary hold)
    if (duration > 350) {
      setTool(state.prevTool || 'pen', { isUserSwitch: false });
    }
  }
}

export function cancelSpringKeys() {
  if (state.springKey) {
    state.springKey = null;
    eDownTime = 0;
    setTool(state.prevTool || 'pen', { isUserSwitch: false });
  }
  if (state.isSpacePressed) {
    const toolBefore = state.spaceToolBefore || 'pen';
    state.isSpacePressed = false;
    state.spaceDownTime = null;
    state.spaceToolBefore = null;
    state.spaceDidPan = false;
    setTool(toolBefore, { isUserSwitch: false });
  }
}
