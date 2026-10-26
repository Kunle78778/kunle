/**
 * a11y.js —— 无障碍与键盘操作增强
 *
 * 提供四件事：
 *   1. 全局快捷键注册（Ctrl+Enter 计算、Alt+1~4 排序、Ctrl+E 导出…）
 *   2. 屏幕阅读器播报（aria-live）
 *   3. 弹窗焦点陷阱（打开时锁住 Tab，关闭时把焦点还回去）
 *   4. 选项卡的 roving tabindex（左右方向键切换）
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KunleA11y = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function createLiveRegion() {
    let region = document.getElementById('kunle-live');
    if (region) return region;
    region = document.createElement('div');
    region.id = 'kunle-live';
    region.className = 'sr-only';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    document.body.appendChild(region);
    return region;
  }

  /**
   * @param {object} options
   * @param {Object<string, Function>} options.shortcuts 形如 { 'ctrl+enter': fn }
   */
  function init(options) {
    const o = options || {};
    const shortcuts = o.shortcuts || {};
    const live = createLiveRegion();
    let trapEl = null;
    let trapPrevFocus = null;

    /* ---------- 快捷键 ---------- */
    function normalize(e) {
      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push('ctrl');
      if (e.altKey) parts.push('alt');
      if (e.shiftKey) parts.push('shift');
      const key = String(e.key || '').toLowerCase();
      parts.push(key === ' ' ? 'space' : key);
      return parts.join('+');
    }

    function onKeydown(e) {
      // 焦点陷阱（弹层/详情打开时锁住 Tab）
      if (trapEl && e.key === 'Tab') {
        const nodes = [...trapEl.querySelectorAll(FOCUSABLE)].filter(
          (n) => n.offsetParent !== null || n === document.activeElement
        );
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }

      // Esc：无论有没有焦点陷阱都应该能关闭当前浮层
      if (e.key === 'Escape' && typeof o.onEscape === 'function') {
        const handled = o.onEscape(e);
        if (handled !== false) {
          e.preventDefault();
          return;
        }
      }

      const combo = normalize(e);
      const handler = shortcuts[combo];
      if (handler) {
        e.preventDefault();
        handler(e);
      }
    }

    document.addEventListener('keydown', onKeydown);

    /* ---------- 播报 ---------- */
    function announce(message) {
      if (!message) return;
      live.textContent = '';
      // 清空再写入，确保同样的文字也会被重新播报
      setTimeout(() => {
        live.textContent = String(message);
      }, 30);
    }

    /* ---------- 焦点陷阱 ---------- */
    function trapFocus(element) {
      if (!element) return;
      trapPrevFocus = document.activeElement;
      trapEl = element;
      const nodes = [...element.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      (nodes[0] || element).focus();
    }

    function releaseFocus() {
      trapEl = null;
      if (trapPrevFocus && typeof trapPrevFocus.focus === 'function') {
        trapPrevFocus.focus();
      }
      trapPrevFocus = null;
    }

    /* ---------- 选项卡 roving tabindex ---------- */
    function initTabs(tablist) {
      if (!tablist) return;
      const tabs = [...tablist.querySelectorAll('[role="tab"], .tab')];
      if (!tabs.length) return;

      tabs.forEach((tab, i) => {
        tab.setAttribute('tabindex', i === 0 ? '0' : '-1');
        tab.setAttribute('role', 'tab');
        tab.addEventListener('keydown', (e) => {
          let next = null;
          if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
          else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
          else if (e.key === 'Home') next = tabs[0];
          else if (e.key === 'End') next = tabs[tabs.length - 1];
          if (!next) return;
          e.preventDefault();
          tabs.forEach((t) => t.setAttribute('tabindex', '-1'));
          next.setAttribute('tabindex', '0');
          next.focus();
          next.click();
        });
      });

      // 点击时同步 tabindex，保持语义一致
      tablist.addEventListener('click', (e) => {
        const tab = e.target.closest('[role="tab"], .tab');
        if (!tab) return;
        tabs.forEach((t) => t.setAttribute('tabindex', t === tab ? '0' : '-1'));
      });
    }

    function destroy() {
      document.removeEventListener('keydown', onKeydown);
      releaseFocus();
    }

    return { announce, trapFocus, releaseFocus, initTabs, destroy };
  }

  return { init, FOCUSABLE };
});
