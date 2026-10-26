/**
 * store.js —— 本地持久化（localStorage）
 *
 * 存两类东西：
 *   1. 设置：权重、最少换乘、最长等待、主题、筛选条件
 *   2. 历史：最近若干次录入/计算快照，可一键回填
 *
 * 全部只存在本机浏览器里，不上传。无 localStorage 时（例如 Node 测试）
 * 自动降级为内存存储，行为一致。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KunleStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY_SETTINGS = 'kunle.settings.v2';
  const KEY_HISTORY = 'kunle.history.v2';
  const HISTORY_LIMIT = 20;

  /* ------------------------------------------------------------------ *
   * 存储适配层（浏览器 localStorage / 内存）
   * ------------------------------------------------------------------ */
  const memory = new Map();

  const backend = (() => {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        const probe = '__kunle_probe__';
        localStorage.setItem(probe, '1');
        localStorage.removeItem(probe);
        return localStorage;
      }
    } catch {
      /* 隐私模式 / 无权限时降级 */
    }
    return {
      getItem: (k) => (memory.has(k) ? memory.get(k) : null),
      setItem: (k, v) => memory.set(k, v),
      removeItem: (k) => memory.delete(k),
    };
  })();

  function readJSON(key, fallback) {
    try {
      const raw = backend.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      backend.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */
  const DEFAULT_SETTINGS = {
    weight: 55,
    minTransfer: 30,
    maxWait: 480,
    hub: '',
    theme: 'auto', // auto | light | dark
    maxLegs: 2,
    filters: {
      onlyBuyable: false,
      onlyDirect: false,
      seatKeyword: '',
      departFrom: '',
      departTo: '',
      maxPrice: null,
      maxDuration: null,
      excludeOvernight: false,
    },
  };

  function loadSettings() {
    const saved = readJSON(KEY_SETTINGS, {});
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      filters: { ...DEFAULT_SETTINGS.filters, ...(saved.filters || {}) },
    };
  }

  function saveSettings(patch) {
    const next = { ...loadSettings(), ...(patch || {}) };
    if (patch && patch.filters) next.filters = { ...loadSettings().filters, ...patch.filters };
    writeJSON(KEY_SETTINGS, next);
    return next;
  }

  function resetSettings() {
    backend.removeItem(KEY_SETTINGS);
    return loadSettings();
  }

  /* ------------------------------------------------------------------ *
   * 历史快照
   * ------------------------------------------------------------------ */

  /**
   * @param {object} snapshot { rows, hub, weight, minTransfer, maxWait, maxLegs, summary }
   */
  function saveSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.rows)) return null;
    const list = loadHistory();
    const entry = {
      id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      createdAt: new Date().toISOString(),
      rows: snapshot.rows,
      hub: snapshot.hub || '',
      weight: snapshot.weight,
      minTransfer: snapshot.minTransfer,
      maxWait: snapshot.maxWait,
      maxLegs: snapshot.maxLegs,
      summary: snapshot.summary || {},
      signature: snapshot.signature || '',
    };
    const next = [entry, ...list].slice(0, HISTORY_LIMIT);
    writeJSON(KEY_HISTORY, next);
    return entry;
  }

  function loadHistory() {
    const list = readJSON(KEY_HISTORY, []);
    return Array.isArray(list) ? list : [];
  }

  function removeSnapshot(id) {
    const next = loadHistory().filter((h) => h.id !== id);
    writeJSON(KEY_HISTORY, next);
    return next;
  }

  function clearHistory() {
    backend.removeItem(KEY_HISTORY);
    return [];
  }

  /* ------------------------------------------------------------------ *
   * 导入 / 导出（设置 + 历史一起打包）
   * ------------------------------------------------------------------ */
  function exportAll() {
    return JSON.stringify(
      { version: 2, exportedAt: new Date().toISOString(), settings: loadSettings(), history: loadHistory() },
      null,
      2
    );
  }

  function importAll(text, { merge = true } = {}) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('不是合法的 JSON');
    }
    if (!data || typeof data !== 'object') throw new Error('格式不正确');

    if (data.settings) saveSettings(data.settings);

    let history = loadHistory();
    if (Array.isArray(data.history)) {
      history = merge ? [...data.history, ...history].slice(0, HISTORY_LIMIT) : data.history;
      writeJSON(KEY_HISTORY, history);
    }
    return { settings: loadSettings(), history };
  }

  /** 生成用于「上次的参数」回填的精简对象 */
  function summarise(rows, options) {
    const groups = { direct: 0, leg1: 0, leg2: 0, leg3: 0 };
    for (const r of rows || []) {
      if (groups[r.group] != null) groups[r.group] += 1;
    }
    return {
      rows: (rows || []).length,
      groups,
      options: (options || []).length,
      at: new Date().toISOString(),
    };
  }

  return {
    KEY_SETTINGS,
    KEY_HISTORY,
    HISTORY_LIMIT,
    DEFAULT_SETTINGS,
    loadSettings,
    saveSettings,
    resetSettings,
    saveSnapshot,
    loadHistory,
    removeSnapshot,
    clearHistory,
    exportAll,
    importAll,
    summarise,
  };
});
