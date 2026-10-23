/**
 * app.js —— 车票最优助手前端
 *
 * 职责：
 *   1. 采集用户输入（出发/到达/日期/是否允许中转/省钱省时权重）
 *   2. 调用后端 /api/search 拿到直达 + 中转方案
 *   3. 在前端做排序：最便宜、最省时、综合最优（可调权重）、Pareto 前沿
 *   4. 渲染推荐卡片与全部方案列表
 */

(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 常量与状态
   * ------------------------------------------------------------------ */
  const STORAGE_KEY = 'kunle.apiBase';
  const DEFAULT_API = ''; // 空字符串 = 同源，即 /api/...

  const state = {
    apiBase: localStorage.getItem(STORAGE_KEY) || DEFAULT_API,
    result: null,
    options: [],
    sort: 'score',
    weight: 55,
    onlyBuyable: false,
    onlyDirect: false,
    loading: false,
  };

  const $ = (id) => document.getElementById(id);

  const el = {
    form: $('searchForm'),
    from: $('fromInput'),
    to: $('toInput'),
    date: $('dateInput'),
    transfer: $('transferInput'),
    weight: $('weightInput'),
    weightOut: $('weightOut'),
    submit: $('submitBtn'),
    swap: $('swapBtn'),
    status: $('status'),
    recommend: $('recommend'),
    recommendGrid: $('recommendGrid'),
    results: $('results'),
    resultsTitle: $('resultsTitle'),
    list: $('list'),
    tabs: $('sortTabs'),
    countInfo: $('countInfo'),
    onlyBuyable: $('onlyBuyable'),
    onlyDirect: $('onlyDirect'),
    sourceBadge: $('sourceBadge'),
    settingsBtn: $('settingsBtn'),
    settingsPanel: $('settingsPanel'),
    apiInput: $('apiInput'),
    apiSave: $('apiSave'),
    apiReset: $('apiReset'),
    apiTest: $('apiTest'),
    apiHint: $('apiHint'),
    drawerClose: $('drawerClose'),
    buildInfo: $('buildInfo'),
    fromSuggest: $('fromSuggest'),
    toSuggest: $('toSuggest'),
  };

  /* ------------------------------------------------------------------ *
   * 工具函数
   * ------------------------------------------------------------------ */
  const pad = (n) => String(n).padStart(2, '0');

  function isoDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function addDays(iso, days) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return isoDate(d);
  }

  function fmtDuration(min) {
    if (min == null) return '—';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}小时${pad(m)}分` : `${m}分`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function apiUrl(path) {
    const base = state.apiBase ? state.apiBase.replace(/\/+$/, '') : '';
    return `${base}${path}`;
  }

  function setStatus(html, kind) {
    if (!html) {
      el.status.hidden = true;
      el.status.className = 'status';
      el.status.innerHTML = '';
      return;
    }
    el.status.hidden = false;
    el.status.className = 'status' + (kind ? ` is-${kind}` : '');
    el.status.innerHTML = html;
  }

  function setSourceBadge(text, kind) {
    el.sourceBadge.textContent = text;
    el.sourceBadge.className = 'badge ' + (kind || 'badge-muted');
  }

  /* ------------------------------------------------------------------ *
   * 日期初始化：12306 预售期按 15 天处理
   * ------------------------------------------------------------------ */
  function initDates() {
    const today = new Date();
    const def = isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
    el.date.min = isoDate(today);
    el.date.max = isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14));
    el.date.value = def;
  }

  /* ------------------------------------------------------------------ *
   * 城市联想
   * ------------------------------------------------------------------ */
  function attachCitySuggest(input, listEl) {
    let timer = null;
    let items = [];
    let active = -1;

    const hide = () => {
      listEl.hidden = true;
      listEl.innerHTML = '';
      items = [];
      active = -1;
    };

    const render = () => {
      if (!items.length) return hide();
      listEl.innerHTML = items
        .map((c, i) => {
          const extra = c.stations && c.stations.length > 1
            ? `${c.stations.length} 个车站`
            : '';
          return `<li data-i="${i}" data-name="${escapeHtml(c.name)}" class="${i === active ? 'is-active' : ''}">
            <span>${escapeHtml(c.name)}</span><span class="st-count">${extra}</span>
          </li>`;
        })
        .join('');
      listEl.hidden = false;
    };

    const pick = (name) => {
      input.value = name;
      hide();
      input.dispatchEvent(new Event('change'));
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) return hide();
      timer = setTimeout(async () => {
        try {
          const res = await fetch(apiUrl(`/api/cities?q=${encodeURIComponent(q)}&limit=10`));
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '联想失败');
          items = data.cities || [];
          active = -1;
          render();
        } catch {
          hide();
        }
      }, 220);
    });

    input.addEventListener('keydown', (e) => {
      if (listEl.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        active = Math.min(active + 1, items.length - 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(active - 1, 0);
        render();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        pick(items[active].name);
      } else if (e.key === 'Escape') {
        hide();
      }
    });

    listEl.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      e.preventDefault();
      pick(li.dataset.name);
    });

    input.addEventListener('blur', () => setTimeout(hide, 120));
    input.addEventListener('focus', () => {
      if (input.value.trim()) input.dispatchEvent(new Event('input'));
    });
  }

  /* ------------------------------------------------------------------ *
   * 数据整形：把直达与中转统一成 option
   * ------------------------------------------------------------------ */
  function toOptions(data) {
    const opts = [];

    for (const t of data.direct || []) {
      if (!t.departMin) continue;
      const arriveDay = t.arriveMin >= 1440 ? 1 : 0;
      opts.push({
        kind: 'direct',
        key: `d-${t.trainNo}`,
        code: t.code,
        depart: t.depart,
        arrive: t.arrive,
        arriveDay,
        durationMin: t.duration,
        price: t.price,
        prices: t.prices,
        buyable: (t.seats || []).some((s) => s.available) && t.canBuy !== false,
        seats: t.seats || [],
        fromStation: t.fromStation,
        toStation: t.toStation,
        legs: [
          {
            code: t.code,
            from: t.fromStation,
            to: t.toStation,
            depart: t.depart,
            arrive: t.arrive,
            price: t.price,
          },
        ],
      });
    }

    for (const c of data.transfers || []) {
      const a = c.leg1, b = c.leg2;
      if (!a || !b) continue;
      const arriveDay = a.arriveMin + (b.duration || 0) + c.waitMin >= 1440 ? 1 : 0;
      const buyable =
        (a.seats || []).some((s) => s.available) && (b.seats || []).some((s) => s.available);
      opts.push({
        kind: 'transfer',
        key: `t-${a.trainNo}-${b.trainNo}`,
        code: `${a.code} + ${b.code}`,
        depart: a.depart,
        arrive: b.arrive,
        arriveDay,
        durationMin: c.totalMinutes,
        price: c.totalPrice,
        prices: null,
        buyable,
        seats: [],
        fromStation: a.fromStation,
        toStation: b.toStation,
        hub: c.hub,
        waitMin: c.waitMin,
        sameStation: c.sameStation,
        legs: [
          { code: a.code, from: a.fromStation, to: a.toStation, depart: a.depart, arrive: a.arrive, price: a.price },
          { code: b.code, from: b.fromStation, to: b.toStation, depart: b.depart, arrive: b.arrive, price: b.price },
        ],
      });
    }

    return opts;
  }

  /* ------------------------------------------------------------------ *
   * 评分与 Pareto
   *   综合分 = 权重 × 价格归一化 + (1-权重) × 时间归一化   （越小越好）
   *   Pareto：没有任何方案在「价格更低」和「时间更短」上同时优于它
   * ------------------------------------------------------------------ */
  function analyze(options, weightPercent) {
    const priced = options.filter((o) => o.price != null && o.durationMin != null);
    const prices = priced.map((o) => o.price);
    const times = priced.map((o) => o.durationMin);
    const minP = Math.min(...prices), maxP = Math.max(...prices);
    const minT = Math.min(...times), maxT = Math.max(...times);

    const norm = (v, lo, hi) => (hi === lo ? 0.5 : (v - lo) / (hi - lo));
    const w = Math.min(100, Math.max(0, weightPercent)) / 100;

    for (const o of options) {
      if (o.price == null || o.durationMin == null) {
        o.score = 9;
        o.pareto = false;
        continue;
      }
      const pn = norm(o.price, minP, maxP);
      const tn = norm(o.durationMin, minT, maxT);
      o.score = w * pn + (1 - w) * tn;
      o.pareto = !priced.some(
        (x) =>
          x !== o &&
          x.price <= o.price &&
          x.durationMin <= o.durationMin &&
          (x.price < o.price || x.durationMin < o.durationMin)
      );
    }
    return options;
  }

  function recommended(options) {
    const usable = options.filter((o) => o.price != null);
    if (!usable.length) return [];
    const byPrice = [...usable].sort((a, b) => a.price - b.price)[0];
    const byTime = [...usable].sort((a, b) => a.durationMin - b.durationMin)[0];
    const byScore = [...usable].sort((a, b) => a.score - b.score)[0];

    const out = [
      { card: 'is-cheap', tag: '最划算 · 花钱最少', data: byPrice, note: '全方案中最便宜的买法' },
      { card: 'is-fast', tag: '最省时 · 到得最早', data: byTime, note: '含换乘等待，总耗时最短' },
      { card: 'is-best', tag: `综合最优 · ${state.weight}% 省钱`, data: byScore, note: '按你设定的省钱/省时权重加权' },
    ];

    // 去重：同一方案只保留优先级最高的一张卡
    const seen = new Set();
    return out.filter((x) => {
      if (!x.data || seen.has(x.data.key)) return false;
      seen.add(x.data.key);
      return true;
    });
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */
  function seatChips(seats) {
    if (!seats || !seats.length) return '';
    return `<div class="seats">${seats
      .slice(0, 6)
      .map(
        (s) =>
          `<span class="seat-chip ${s.available ? '' : 'is-none'}">${escapeHtml(s.name)} <b>${
            s.available ? escapeHtml(s.text) : '无'
          }</b></span>`
      )
      .join('')}</div>`;
  }

  function legList(o) {
    if (o.kind !== 'transfer') return '';
    const rows = o.legs
      .map(
        (l, i) =>
          `<li>第${i + 1}程 <b>${escapeHtml(l.code)}</b> ${escapeHtml(l.from)} ${escapeHtml(
            l.depart
          )} → ${escapeHtml(l.to)} ${escapeHtml(l.arrive)}${
            l.price != null ? ` · ¥${l.price}` : ''
          }</li>`
      )
      .join('');
    const wait = `<li class="wait-tip">在 ${escapeHtml(o.hub)} 换乘，等待 ${fmtDuration(
      o.waitMin
    )}${o.sameStation ? '（同站换乘）' : '（需跨站，已多留缓冲）'}</li>`;
    return `<ul class="legs">${rows}${wait}</ul>`;
  }

  function renderItem(o) {
    const typePill =
      o.kind === 'transfer'
        ? `<span class="type-pill is-transfer">中转 · ${escapeHtml(o.hub)}</span>`
        : `<span class="type-pill">直达</span>`;
    const paretoPill = o.pareto ? `<span class="pareto-pill">性价比前沿</span>` : '';
    const dayTag = o.arriveDay ? '<span class="arrow">+1天</span>' : '';
    const priceHtml =
      o.price == null
        ? `<div class="price is-unknown">票价待查</div><div class="price-note">12306 未返回</div>`
        : `<div class="price">¥${o.price}<small>起</small></div><div class="price-note">${
            o.kind === 'transfer' ? '两程合计' : '最低舱位'
          }</div>`;

    return `<article class="item ${o.pareto ? 'is-pareto' : ''}">
      <div>
        <div class="item-head">
          <span class="train-code">${escapeHtml(o.code)}</span>
          ${typePill}${paretoPill}
        </div>
        <div class="timeline">
          <span class="tm">${escapeHtml(o.depart)}</span>
          <span class="st">${escapeHtml(o.fromStation)}</span>
          <span class="arrow">──${fmtDuration(o.durationMin)}──▶</span>
          <span class="tm">${escapeHtml(o.arrive)}</span>
          ${dayTag}
          <span class="st">${escapeHtml(o.toStation)}</span>
        </div>
        ${legList(o)}
        ${seatChips(o.seats)}
      </div>
      <div class="price-box">${priceHtml}</div>
    </article>`;
  }

  function renderRecommend(options) {
    const recs = recommended(options);
    if (!recs.length) {
      el.recommend.hidden = true;
      return;
    }
    el.recommendGrid.innerHTML = recs
      .map(({ card, tag, data, note }) => {
        const price = data.price == null ? '票价待查' : `¥${data.price}`;
        const route =
          data.kind === 'transfer'
            ? `${escapeHtml(data.legs[0].from)} → ${escapeHtml(data.hub)} → ${escapeHtml(data.legs[1].to)}`
            : `${escapeHtml(data.fromStation)} → ${escapeHtml(data.toStation)}`;
        return `<div class="rec-card ${card}">
          <span class="rec-tag">${tag}</span>
          <div class="rec-main">${price}<small>${data.kind === 'transfer' ? '两程合计' : ''}</small></div>
          <div class="rec-sub">${escapeHtml(data.code)} · ${fmtDuration(data.durationMin)} · ${escapeHtml(
            data.depart
          )} 发车</div>
          <div class="rec-sub">${route}</div>
          <div class="rec-sub muted">${note}</div>
        </div>`;
      })
      .join('');
    el.recommend.hidden = false;
  }

  function visibleOptions() {
    let list = [...state.options];
    if (state.onlyDirect) list = list.filter((o) => o.kind === 'direct');
    if (state.onlyBuyable) list = list.filter((o) => o.buyable);
    return list;
  }

  function sortOptions(list) {
    const by = state.sort;
    const copy = [...list];
    if (by === 'price') {
      copy.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    } else if (by === 'time') {
      copy.sort((a, b) => (a.durationMin ?? Infinity) - (b.durationMin ?? Infinity));
    } else if (by === 'depart') {
      copy.sort((a, b) => (a.departLex ?? a.depart).localeCompare(b.departLex ?? b.depart));
    } else {
      copy.sort((a, b) => a.score - b.score);
    }
    return copy;
  }

  function renderList() {
    const list = sortOptions(visibleOptions());
    const directCount = state.options.filter((o) => o.kind === 'direct').length;
    const transferCount = state.options.length - directCount;

    el.countInfo.textContent = `共 ${state.options.length} 个方案（直达 ${directCount} · 中转 ${transferCount}）`;
    el.resultsTitle.textContent = `${state.result.from.name} → ${state.result.to.name} · ${state.result.date}`;

    if (!list.length) {
      el.list.innerHTML = `<p class="muted">没有符合条件的方案，试试取消筛选或打开中转。</p>`;
      return;
    }
    el.list.innerHTML = list.map(renderItem).join('');
  }

  /* ------------------------------------------------------------------ *
   * 查询主流程
   * ------------------------------------------------------------------ */
  async function doSearch() {
    const from = el.from.value.trim();
    const to = el.to.value.trim();
    const date = el.date.value;

    if (!from || !to) return setStatus('请填写出发城市和到达城市', 'error');
    if (!date) return setStatus('请选择出发日期', 'error');
    if (state.loading) return;

    state.loading = true;
    el.submit.disabled = true;
    el.submit.textContent = '计算中…';
    setStatus('<span class="spinner"></span>正在向 12306 查询车次与票价，含中转组合可能需要几秒…', 'loading');
    el.recommend.hidden = true;
    el.results.hidden = true;

    const t0 = performance.now();
    try {
      const url = apiUrl(
        `/api/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
          `&date=${encodeURIComponent(date)}&transfer=${el.transfer.checked ? 1 : 0}`
      );
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '查询失败');

      state.result = data;
      state.options = analyze(toOptions(data), state.weight);

      if (!state.options.length) {
        setStatus(
          `没有查到 ${data.from.name} → ${data.to.name} 在 ${date} 的车次。可能原因：该日期未放票、城市名不准确，或两地无直达需换乘。`,
          'error'
        );
        setSourceBadge('数据源：12306 已连接', 'badge-ok');
        return;
      }

      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const unknown = state.options.filter((o) => o.price == null).length;
      setStatus(
        `已获取 ${state.options.length} 个方案（直达 ${
          data.direct.length
        } · 中转 ${data.transfers.length}），耗时 ${secs}s。` +
          (unknown ? ` 其中 ${unknown} 个方案 12306 未返回票价，已排在最后。` : '')
      );
      setSourceBadge('数据源：12306 实时', 'badge-ok');

      renderRecommend(state.options);
      renderList();
      el.results.hidden = false;
    } catch (err) {
      console.error(err);
      setStatus(
        `查询失败：${escapeHtml(err.message || err)}<br><span class="muted small">` +
          `若提示网络错误，请确认代理地址可用（点右上角「设置」）。</span>`,
        'error'
      );
      setSourceBadge('数据源：连接失败', 'badge-err');
    } finally {
      state.loading = false;
      el.submit.disabled = false;
      el.submit.textContent = '开始计算';
    }
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */
  function bind() {
    el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      doSearch();
    });

    el.swap.addEventListener('click', () => {
      const a = el.from.value;
      el.from.value = el.to.value;
      el.to.value = a;
    });

    el.weight.addEventListener('input', () => {
      state.weight = Number(el.weight.value);
      el.weightOut.textContent = `${state.weight}% 省钱`;
      if (state.result) {
        state.options = analyze(state.options, state.weight);
        renderRecommend(state.options);
        renderList();
      }
    });

    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      [...el.tabs.children].forEach((b) => b.classList.toggle('is-active', b === btn));
      state.sort = btn.dataset.sort;
      renderList();
    });

    el.onlyBuyable.addEventListener('change', () => {
      state.onlyBuyable = el.onlyBuyable.checked;
      renderList();
    });

    el.onlyDirect.addEventListener('change', () => {
      state.onlyDirect = el.onlyDirect.checked;
      renderList();
    });

    // 设置抽屉
    el.settingsBtn.addEventListener('click', () => {
      el.apiInput.value = state.apiBase;
      el.apiHint.textContent = '';
      el.settingsPanel.hidden = false;
    });
    el.drawerClose.addEventListener('click', () => (el.settingsPanel.hidden = true));
    el.settingsPanel.addEventListener('click', (e) => {
      if (e.target === el.settingsPanel) el.settingsPanel.hidden = true;
    });

    el.apiSave.addEventListener('click', () => {
      state.apiBase = el.apiInput.value.trim().replace(/\/+$/, '');
      localStorage.setItem(STORAGE_KEY, state.apiBase);
      el.apiHint.textContent = state.apiBase
        ? `已保存：${state.apiBase}`
        : '已恢复为同源默认（/api）';
      setSourceBadge('数据源：已切换，请重新查询', 'badge-muted');
    });

    el.apiReset.addEventListener('click', () => {
      state.apiBase = DEFAULT_API;
      localStorage.removeItem(STORAGE_KEY);
      el.apiInput.value = '';
      el.apiHint.textContent = '已恢复为同源默认（/api）';
    });

    el.apiTest.addEventListener('click', async () => {
      const base = el.apiInput.value.trim().replace(/\/+$/, '');
      el.apiHint.textContent = '测试中…';
      try {
        const res = await fetch(`${base}/api/health`);
        const data = await res.json();
        el.apiHint.textContent = data.ok ? `连接正常：${JSON.stringify(data)}` : '返回异常';
      } catch (err) {
        el.apiHint.textContent = `连接失败：${err.message}`;
      }
    });

    attachCitySuggest(el.from, el.fromSuggest);
    attachCitySuggest(el.to, el.toSuggest);
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  /** 支持 ?from=北京&to=上海&date=2026-10-24&transfer=1 直接查询（方便分享链接） */
  function applyUrlParams() {
    const q = new URLSearchParams(location.search);
    const from = q.get('from');
    const to = q.get('to');
    const date = q.get('date');
    const transfer = q.get('transfer');

    if (from) el.from.value = from;
    if (to) el.to.value = to;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) el.date.value = date;
    if (transfer != null) el.transfer.checked = ['1', 'true', 'yes'].includes(transfer.toLowerCase());
    const w = Number(q.get('w'));
    if (Number.isFinite(w) && w >= 0 && w <= 100) {
      state.weight = w;
      el.weight.value = String(w);
    }
    return Boolean(from && to);
  }

  function boot() {
    initDates();
    bind();
    el.weightOut.textContent = `${state.weight}% 省钱`;
    el.buildInfo.textContent = document.lastModified
      ? `页面更新：${new Date(document.lastModified).toLocaleString('zh-CN')}`
      : '';

    // 探测后端是否可用，给出直观提示
    fetch(apiUrl('/api/health'))
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setSourceBadge('数据源：代理已就绪', 'badge-ok');
      })
      .catch(() => {
        setSourceBadge('数据源：未连接代理', 'badge-err');
        setStatus(
          '当前页面找不到可用的 /api 代理。本地使用时请运行 <code>node server/server.mjs</code>；' +
            '部署到 GitHub Pages 时请在右上角「设置」里填入你的 Cloudflare Worker 地址。',
          'error'
        );
      });

    if (applyUrlParams()) {
      setTimeout(doSearch, 60);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
