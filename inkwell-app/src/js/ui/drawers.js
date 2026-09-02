/* ============================================================================
 * ui/drawers.js — Navigation Slide-Out Panels & Rail Buttons for Inkwell
 * Renders Thumbnails, Table of Contents, Bookmarks, and Search Panels.
 * ========================================================================== */

import { state, $, escapeHtml, emit } from '../core/state.js';
import * as templates from '../render/templates.js';
import * as ipc from '../core/ipc.js';
import * as textSelection from '../workspace/text-selection.js';
import * as compositor from '../render/compositor.js';

let _goToPageCallback = null;

export function setGoToPageCallback(cb) {
  _goToPageCallback = cb;
}

export function initDrawers() {
  bindRailButtons();
  bindMoreMenu();
  bindSearchEvents();
}

function bindRailButtons() {
  $('btnRailThumbnails') && $('btnRailThumbnails').addEventListener('click', () => toggleDrawer('thumbnails'));
  $('btnRailOutline') && $('btnRailOutline').addEventListener('click', () => toggleDrawer('outline'));
  $('btnRailSearch') && $('btnRailSearch').addEventListener('click', () => toggleDrawer('search'));
  $('btnRailBookmarks') && $('btnRailBookmarks').addEventListener('click', () => toggleDrawer('bookmarks'));
  $('btnRailLayers') && $('btnRailLayers').addEventListener('click', () => toggleDrawer('layers'));
  $('btnRailDocInfo') && $('btnRailDocInfo').addEventListener('click', () => toggleDrawer('docinfo'));
  $('btnRailSettings') && $('btnRailSettings').addEventListener('click', () => {
    const modal = $('settingsModal');
    if (modal) modal.classList.remove('hidden');
    else toggleDrawer('settings');
  });
  $('btnCloseDrawer') && $('btnCloseDrawer').addEventListener('click', () => closeDrawer());

  $('btnToggleSidebar') && $('btnToggleSidebar').addEventListener('click', () => toggleDrawer('thumbnails'));
  $('btnCollapseSidebar') && $('btnCollapseSidebar').addEventListener('click', () => closeDrawer());

  // Listen for hardware diagnostics events
  import('../core/state.js').then(({ on }) => {
    on('hardwareDiagnostics', payload => updateHardwareDiagnosticsUI(payload));
  });
}

let _diagElements = null;

export function updateHardwareDiagnosticsUI(diag) {
  if (!diag) return;

  const modal = $('settingsModal');
  const isSettingsVisible = (modal && !modal.classList.contains('hidden')) || state.activeDrawer === 'settings' || state.activeDrawer === 'docinfo';
  if (!isSettingsVisible) return;

  if (!_diagElements) {
    _diagElements = {
      pointerType: $('diagPointerType'),
      pressureSource: $('diagPressureSource'),
      activeDevice: $('diagActiveDevice'),
      livePressure: $('diagLivePressure'),
    };
  }

  if (_diagElements.pointerType) {
    _diagElements.pointerType.textContent = diag.pointerType === 'pen'
      ? 'Stylus Pen'
      : (diag.pointerType === 'eraser' ? 'Stylus Eraser' : 'Mouse / Trackpad');
  }
  if (_diagElements.pressureSource) {
    if (diag.pressureSource === 'native') {
      _diagElements.pressureSource.textContent = 'Native Linux (evdev)';
      _diagElements.pressureSource.className = 'diag-badge green';
    } else if (diag.pressureSource === 'browser') {
      _diagElements.pressureSource.textContent = 'Browser (PointerEvent)';
      _diagElements.pressureSource.className = 'diag-badge';
    } else {
      _diagElements.pressureSource.textContent = 'Fallback (0.5)';
      _diagElements.pressureSource.className = 'diag-badge';
    }
  }
  if (_diagElements.activeDevice && diag.device) {
    _diagElements.activeDevice.textContent = `${diag.device.name || 'Device'} (${diag.device.path || ''})`;
    _diagElements.activeDevice.title = `${diag.device.name || ''} at ${diag.device.path || ''}`;
  }
  if (_diagElements.livePressure && diag.pressure != null) {
    _diagElements.livePressure.textContent = Number(diag.pressure).toFixed(2);
  }
}

function bindMoreMenu() {
  const btnMore = $('btnRailMore');
  const menu = $('moreOptionsMenu');
  if (btnMore && menu) {
    btnMore.addEventListener('click', e => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('#moreOptionsMenu') && !e.target.closest('#btnRailMore')) {
        menu.classList.add('hidden');
      }
    });
  }
}

export function openDrawer(drawerName) {
  const drawer = $('navDrawer');
  if (!drawer) return;

  state.activeDrawer = drawerName;
  drawer.classList.remove('hidden');

  // Highlight active rail button
  document.querySelectorAll('.rail-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  const btnMap = {
    thumbnails: $('btnRailThumbnails'),
    outline: $('btnRailOutline'),
    search: $('btnRailSearch'),
    bookmarks: $('btnRailBookmarks'),
    layers: $('btnRailLayers'),
    docinfo: $('btnRailDocInfo'),
  };

  const activeBtn = btnMap[drawerName] || $(`btnRail${drawerName.charAt(0).toUpperCase() + drawerName.slice(1)}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Show corresponding drawer pane
  document.querySelectorAll('.drawer-view').forEach(view => view.classList.add('hidden'));
  const targetView = $(`drawerView_${drawerName}`) || $(`drawer${drawerName.charAt(0).toUpperCase() + drawerName.slice(1)}`);
  if (targetView) targetView.classList.remove('hidden');

  const titleEl = $('drawerTitle');
  if (titleEl) {
    const titles = {
      thumbnails: 'Thumbnails',
      outline: 'Document Outline',
      search: 'Search in Document',
      bookmarks: 'Bookmarks',
      docinfo: 'Document Details',
      layers: 'Vector Layers',
      settings: 'Preferences',
    };
    titleEl.textContent = titles[drawerName] || drawerName;
  }

  if (drawerName === 'thumbnails') renderThumbnails();
  else if (drawerName === 'outline') renderOutline();

  emit('drawerOpened', { drawer: drawerName });
}

export function closeDrawer() {
  const drawer = $('navDrawer');
  if (drawer) drawer.classList.add('hidden');
  state.activeDrawer = null;
  document.querySelectorAll('.rail-btn').forEach(btn => {
    if (btn.id !== 'btnRailSplit') btn.classList.remove('active');
  });
  emit('drawerClosed', {});
}

export function toggleDrawer(drawerName) {
  if (state.activeDrawer === drawerName) {
    closeDrawer();
  } else {
    openDrawer(drawerName);
  }
}

export function renderThumbnails() {
  const grid = $('thumbnailGrid');
  if (!grid || !state.pageInfos || !state.pageInfos.length) return;

  grid.innerHTML = '';
  state.pageInfos.forEach((pi, idx) => {
    const card = document.createElement('div');
    card.className = 'thumb-card' + (idx === state.leftSheet ? ' active' : '');
    card.setAttribute('data-page', idx);

    const canvas = document.createElement('canvas');
    canvas.className = 'thumb-canvas';
    canvas.width = 120;
    canvas.height = Math.round(120 * ((pi.height_pt || 842) / (pi.width_pt || 595)));

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = pi.template === 'dark' ? '#0f172a' : '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = `Page ${idx + 1}`;

    card.appendChild(canvas);
    card.appendChild(label);

    card.addEventListener('click', () => {
      if (typeof _goToPageCallback === 'function') {
        _goToPageCallback(idx, 'left');
      }
      grid.querySelectorAll('.thumb-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });

    grid.appendChild(card);
  });
}

export function renderOutline() {
  const container = $('outlineList');
  const emptyState = $('outlineEmptyState');
  if (!container) return;

  const outline = state.outline || [];
  if (!outline.length) {
    container.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  function renderTree(nodes, depth = 0) {
    return nodes.map(node => {
      const hasChildren = node.children && node.children.length > 0;
      const targetPage = node.page_index != null ? node.page_index : null;
      const pageLabel = targetPage != null ? `p. ${targetPage + 1}` : '';
      const childrenHtml = hasChildren ? `<div class="outline-children">${renderTree(node.children, depth + 1)}</div>` : '';

      return `
        <div class="outline-item" data-page="${targetPage != null ? targetPage : ''}">
          <div class="outline-header" data-page="${targetPage != null ? targetPage : ''}">
            <button class="outline-toggle ${hasChildren ? '' : 'leaf'}" title="Toggle section">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <span class="outline-title" title="${escapeHtml(node.title)}">${escapeHtml(node.title)}</span>
            ${pageLabel ? `<span class="outline-page-badge">${pageLabel}</span>` : ''}
          </div>
          ${childrenHtml}
        </div>
      `;
    }).join('');
  }

  container.innerHTML = renderTree(outline);

  container.querySelectorAll('.outline-header').forEach(header => {
    header.addEventListener('click', e => {
      if (e.target.closest('.outline-toggle')) return;
      const pageStr = header.dataset.page;
      if (pageStr !== '' && typeof _goToPageCallback === 'function') {
        const pageIdx = parseInt(pageStr, 10);
        if (!isNaN(pageIdx)) {
          _goToPageCallback(pageIdx, 'left');
          container.querySelectorAll('.outline-item').forEach(el => el.classList.remove('active'));
          header.closest('.outline-item').classList.add('active');
        }
      }
    });
  });
}

function bindSearchEvents() {
  const input = $('drawerSearchInput');
  const go = $('btnExecuteSearch');

  if (go) {
    go.addEventListener('click', () => executeSearch());
  }
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        executeSearch();
      }
    });
  }
}

export function openSearchWithQuery(query) {
  openDrawer('search');
  const input = $('drawerSearchInput');
  if (input) {
    input.value = query;
    executeSearch();
  }
}

export async function executeSearch() {
  const input = $('drawerSearchInput');
  const q = (input && input.value || '').trim();
  state.searchQuery = q;
  state.searchResults = [];

  if (!q) {
    renderSearchResults([]);
    compositor.redrawAll();
    return;
  }

  const results = await ipc.invokeTauri('search_pdf', { query: q }).catch(err => {
    console.warn('[inkwell/drawers] search_pdf error:', err);
    return [];
  });

  const searchRects = await buildSearchRects(q, results || []);
  state.searchResults = searchRects;
  state.activeSearchMatch = 0;
  renderSearchResults(results || []);
  compositor.redrawAll();
}

export async function buildSearchRects(q, results) {
  if (!q || !results || !results.length) return [];
  const qLower = q.toLowerCase();
  const searchRects = [];

  for (const item of results) {
    const pageIndex = item.page_index;
    const pageData = await textSelection.ensurePageTextData(pageIndex);
    if (!pageData || !pageData.chars || !pageData.chars.length) continue;

    const chars = pageData.chars;
    const fullText = chars.map(c => c.c).join('').toLowerCase();
    let pos = 0;

    while ((pos = fullText.indexOf(qLower, pos)) !== -1) {
      if (searchRects.length >= 500) break;
      const matchedChars = chars.slice(pos, pos + qLower.length);
      if (matchedChars.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const ch of matchedChars) {
          if (ch.rect) {
            minX = Math.min(minX, ch.rect[0]);
            minY = Math.min(minY, ch.rect[1]);
            maxX = Math.max(maxX, ch.rect[2]);
            maxY = Math.max(maxY, ch.rect[3]);
          }
        }
        if (minX !== Infinity) {
          searchRects.push({
            pageIndex,
            rect: [minX, minY, maxX, maxY],
            snippet: item.snippet,
          });
        }
      }
      pos += qLower.length || 1;
    }
    if (searchRects.length >= 500) break;
  }
  return searchRects;
}

export function renderSearchResults(searchItems) {
  const container = $('drawerSearchResults');
  if (!container) return;

  if (!searchItems || !searchItems.length) {
    container.innerHTML = `
      <div class="drawer-empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">No Results Found</div>
        <div class="empty-state-desc">Try searching for a different term or keyword.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = searchItems.map((item, idx) => {
    return `
      <div class="search-result-card" data-page="${item.page_index}" data-idx="${idx}">
        <div class="search-result-header">
          <span class="search-page-badge">Page ${item.page_index + 1}</span>
          <span class="search-match-count">${item.match_count || 1} match${(item.match_count || 1) > 1 ? 'es' : ''}</span>
        </div>
        <div class="search-snippet">${escapeHtml(item.snippet)}</div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.search-result-card').forEach(el => {
    el.addEventListener('click', () => {
      const pageStr = el.dataset.page;
      if (pageStr !== '' && typeof _goToPageCallback === 'function') {
        const pageIdx = parseInt(pageStr, 10);
        if (!isNaN(pageIdx)) {
          _goToPageCallback(pageIdx, 'left');
          container.querySelectorAll('.search-result-card').forEach(item => item.classList.remove('active'));
          el.classList.add('active');
        }
      }
    });
  });
}
