/* ============================================================================
 * ui/toast.js — Glassmorphic Toast Notification System for Inkwell
 * Displays transient user feedback notifications with auto-dismiss and ARIA support.
 * ========================================================================== */

import { $ } from '../core/state.js';

export function showToast(message, type = 'info') {
  let container = $('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    const onTransitionEnd = () => {
      toast.removeEventListener('transitionend', onTransitionEnd);
      toast.remove();
    };
    toast.addEventListener('transitionend', onTransitionEnd);
    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 400);
  }, 3000);
}

