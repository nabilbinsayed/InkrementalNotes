/* ============================================================================
 * ui/drawers.js — Navigation Slide-Out Panels & Rail Buttons for Inkwell
 * Renders Thumbnails, Table of Contents, Bookmarks, and Search Panels.
 * ========================================================================== */

import { state, $, escapeHtml, emit } from '../core/state.js';
import * as templates from '../render/templates.js';

let _goToPageCallback = null;

export function setGoToPageCallback(cb) {
  _goToPageCallback = cb;
}

export function initDrawers() {
  bindRailButtons();
  bindMoreMenu();
}

function bindRailButtons() {
  $('btnRailThumbnails') && $('btnRailThumbnails').addEventListener('click', () => toggleDrawer('thumbnails'));
  $('btnRailOutline') && $('btnRailOutline').addEventListener('click', () => toggleDrawer('outline'));
  $('btnRailSearch') && $('btnRailSearch').addEventListener('click', () => toggleDrawer('search'));
  $('btnRailBookmarks') && $('btnRailBookmarks').addEventListener('click', () => toggleDrawer('bookmarks'));
  $('btnRailLayers') && $('btnRailLayers').addEventListener('click', () => toggleDrawer('layers'));
  $('btnRailDocInfo') && $('btnRailDocInfo').addEventListener('click', () => toggleDrawer('docinfo'));
  $('btnCloseDrawer') && $('btnCloseDrawer').addEventListener('click', () => closeDrawer());

  $('btnToggleSidebar') && $('btnToggleSidebar').addEventListener('click', () => toggleDrawer('thumbnails'));
  $('btnCollapseSidebar') && $('btnCollapseSidebar').addEventListener('click', () => closeDrawer());
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
