/* ============================================================================
 * tools/tool-manager.js — Active Tool State Machine for Inkwell
 * Manages active tool selection, spring-loaded keys, and tool property states.
 * Does not implement geometry or rendering algorithms directly.
 * ========================================================================== */

import { state, emit } from '../core/state.js';

export const TOOL_NAMES = [
  'pen', 'highlighter', 'eraser', 'lasso', 'ruler', 'rect', 'ellipse', 'laser', 'text', 'pan'
];

export function getActiveTool() {
  return state.activeTool || 'pen';
}

export function setTool(toolName) {
  if (!toolName) return;
  const tool = toolName.toLowerCase();
  
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

export function handleSpringKeyDown(key) {
  if (state.springKey) return;
  if (key === 'e' || key === 'E') {
    state.springKey = 'e';
    state.prevTool = state.activeTool;
    setTool('eraser');
  } else if (key === ' ' || key === 'Space') {
    state.springKey = 'space';
    state.prevTool = state.activeTool;
    setTool('pan');
  }
}

export function handleSpringKeyUp(key) {
  if (!state.springKey) return;
  if ((key === 'e' || key === 'E') && state.springKey === 'e') {
    state.springKey = null;
    setTool(state.prevTool || 'pen');
  } else if ((key === ' ' || key === 'Space') && state.springKey === 'space') {
    state.springKey = null;
    setTool(state.prevTool || 'pen');
  }
}
