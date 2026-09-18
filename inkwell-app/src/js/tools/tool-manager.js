import { state, emit } from '../core/state.js';
import * as ipc from '../core/ipc.js';

export const TOOL_NAMES = [
  'pen', 'highlighter', 'eraser', 'lasso', 'ruler', 'line', 'rect', 'ellipse', 'laser', 'text', 'textSelect', 'pan'
];

// ---- Native Linux Evdev Hardware Stylus State ----
let liveNativePressure = 0.0;
let liveNativeDown = false;
let liveNativeTool = 'pen';
let lastNativeSampleTime = 0;

let lastPointerTime = 0;
let lastPointerX = 0;
let lastPointerY = 0;
let smoothedVelocityPressure = 0.5;
let browserHasVariedPressure = false;

const activeStylusDevice = {
  name: 'Scanning...',
  path: '',
  minPressure: 0,
  maxPressure: 65535,
};

export function getLiveNativeTool() {
  const now = performance.now();
  if ((now - lastNativeSampleTime) < 350) {
    return liveNativeTool;
  }
  return null;
}

export function resetPressureDynamics() {
  lastPointerTime = 0;
  smoothedVelocityPressure = 0.5;
}

export function initStylusIntegration() {
  ipc.initNativeStylusStream((msg) => {
    if (!msg) return;
    const type = msg.type || (msg.sample ? 'sample' : (msg.handshake ? 'handshake' : null));
    const payload = msg.payload || msg.sample || msg.handshake || msg;

    if (type === 'handshake') {
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
    } else if (type === 'sample') {
      const s = payload;
      if (!s) return;
      liveNativePressure = typeof s.pressure === 'number' ? s.pressure : 0.0;
      liveNativeDown = !!s.down;
      liveNativeTool = s.tool === 2 ? 'eraser' : 'pen';
      lastNativeSampleTime = performance.now();
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
  const now = performance.now();
  const isNativeRecent = (now - lastNativeSampleTime) < 350;

  // 1. Native Linux evdev hardware tablet stream
  if (isNativeRecent && (liveNativeDown || liveNativePressure > 0.001)) {
    state.pressureSource = 'native';
    state.lastPointerType = liveNativeTool;
    const p = Math.max(0.04, Math.min(1.0, liveNativePressure));
    scheduleDiagnostics(liveNativeTool, 'native', p);
    return p;
  }

  // 2. Browser hardware stylus PointerEvent
  if (e && typeof e.pressure === 'number' && e.pressure > 0) {
    if (Math.abs(e.pressure - 0.5) > 0.005) {
      browserHasVariedPressure = true;
    }
    if (browserHasVariedPressure && (e.pointerType === 'pen' || e.pointerType === 'touch')) {
      const pType = e.pointerType || 'pen';
      state.pressureSource = 'browser';
      state.lastPointerType = pType;
      const p = Math.max(0.04, Math.min(1.0, e.pressure));
      scheduleDiagnostics(pType, 'browser', p);
      return p;
    }
  }

  // 3. Dynamic velocity-based pressure calculation
  const clientX = (e && typeof e.clientX === 'number') ? e.clientX : null;
  const clientY = (e && typeof e.clientY === 'number') ? e.clientY : null;
  const evtTime = (e && typeof e.timeStamp === 'number' && e.timeStamp > 0) ? e.timeStamp : now;

  if (clientX !== null && clientY !== null) {
    const dt = Math.max(4, evtTime - lastPointerTime);
    if (dt > 300 || lastPointerTime === 0) {
      smoothedVelocityPressure = 0.5;
    } else {
      const dx = clientX - lastPointerX;
      const dy = clientY - lastPointerY;
      const dist = Math.hypot(dx, dy);
      const speed = dist / dt; // pixels per millisecond
      // Fast flick movements taper (~0.26), slow deliberate curves press thicker (~0.84)
      const speedFactor = Math.exp(-speed / 0.9);
      const targetPressure = 0.26 + 0.58 * speedFactor;
      smoothedVelocityPressure = 0.65 * smoothedVelocityPressure + 0.35 * targetPressure;
    }
    lastPointerTime = evtTime;
    lastPointerX = clientX;
    lastPointerY = clientY;

    const pType = (e && e.pointerType) ? e.pointerType : 'mouse';
    state.pressureSource = 'velocity';
    state.lastPointerType = pType;
    const p = Math.max(0.04, Math.min(1.0, smoothedVelocityPressure));
    scheduleDiagnostics(pType, 'velocity', p);
    return p;
  }

  // 4. Default fallback
  state.pressureSource = 'fallback';
  state.lastPointerType = (e && e.pointerType) ? e.pointerType : 'mouse';
  scheduleDiagnostics(state.lastPointerType, 'fallback', 0.5);
  return 0.5;
}

if (typeof window !== 'undefined') {
  window.resolvePressure = resolvePressure;
  window.resetPressureDynamics = resetPressureDynamics;
  window.getLiveNativeTool = getLiveNativeTool;
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

  if (tool === 'ruler' || tool === 'line') {
    state.activeTool = tool;
    state.shapeKind = 'line';
  } else if (tool === 'rect' || tool === 'ellipse') {
    state.activeTool = tool;
    state.shapeKind = tool;
  } else {
    state.activeTool = tool;
  }

  // Synchronise color and width properties according to tool
  if (state.activeTool === 'highlighter') {
    state.color = state.highlighterColor || [0.99, 0.93, 0.28];
    state.baseWidth = state.highlighterWidth || 16.0;
  } else if (['pen', 'rect', 'ellipse', 'line', 'ruler'].includes(state.activeTool)) {
    const activeColor = state.penColor || state.shapesColor || state.color || [0.08, 0.09, 0.14];
    state.color = activeColor;
    state.penColor = activeColor;
    state.shapesColor = activeColor;
    state.baseWidth = state.penWidth || state.baseWidth || 1.6;
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
  if (state.activeTool === 'highlighter') {
    state.highlighterColor = rgbArray;
  } else {
    state.penColor = rgbArray;
    state.shapesColor = rgbArray;
    const hex = '#' + rgbArray.map(v => Math.round(Math.max(0, Math.min(255, v * 255))).toString(16).padStart(2, '0')).join('');
    state.textColor = hex;
  }

  emit('toolPropertyChanged', { property: 'color', value: rgbArray });
}

export function setWidth(widthPt) {
  const w = Math.max(0.2, Math.min(64, parseFloat(widthPt) || 1.6));
  state.baseWidth = w;
  if (state.activeTool === 'highlighter') {
    state.highlighterWidth = w;
  } else {
    state.penWidth = w;
  }

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
