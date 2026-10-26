/**
 * app.js —— 界面控制器
 *
 * 职责：把「录入 → 解析 → 计算 → 展示」串起来，并管理
 *   设置持久化、筛选、图表、行程详情、历史记录、CSV、打印、主题
 *
 * 计算全部在本地完成；只有截图会送到本机 Node 服务做 OCR。
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /** 构建号：与 version.json 对比，用于发现「浏览器还在跑旧版」 */
  const BUILD = '3.1.1';


  const GROUPS = {
    direct: '直达',
    leg1: '第一程',
    leg2: '第二程',
    leg3: '第三程',
  };

  const SORT_LABEL = {
    score: '综合最优',
    price: '最便宜',
    time: '最省时',
    depart: '最早出发',
  };

  const state = {
    rows: [],
    options: [],
    filtered: [],
    sort: 'score',
    weight: 55,
    settings: null,
    chart: null,
    history: [],
    busy: false,
  };

  /* ------------------------------------------------------------------ *
   * 元素
   * ------------------------------------------------------------------ */
  const el = {};
  function cacheElements() {
    const ids = [      'engineBadge', 'themeBtn', 'printBtn', 'hardResetBtn', 'versionTag',
      'dropzone', 'fileInput', 'pasteArea', 'parseTextBtn',
      'csvImportBtn', 'csvExportBtn', 'csvFileInput',
      'ocrStatus', 'rowsBody', 'emptyHint', 'addRowBtn', 'demoBtn', 'clearBtn',
      'hubInput', 'minTransfer', 'maxWait', 'maxLegs', 'weightInput', 'weightOut', 'computeBtn',
      'status', 'statsBar', 'stCount', 'stPrice', 'stTime', 'stSaved', 'stPareto',
      'recommend', 'recommendGrid',
      'chartCard', 'chartCanvas', 'chartHint',
      'filterToggle', 'filterPanel', 'fSeat', 'fDepartFrom', 'fDepartTo',
      'fMaxPrice', 'fMaxDuration', 'fMaxTransfers', 'fExcludeOvernight', 'resetFiltersBtn',
      'results', 'resultsTitle', 'sortTabs', 'onlyBuyable', 'onlyDirect', 'countInfo', 'list',
      'exportMdBtn', 'exportHtmlBtn', 'issuesCard', 'issuesSummary', 'issuesList',
      'detailCard', 'detailTitle', 'detailTimeline', 'detailBody', 'detailClose',
      'historyCard', 'historyList', 'historyClear',
      'printArea', 'buildInfo',
    ];
    for (const id of ids) el[id] = $(id);

    // 防御：如果页面结构与脚本版本不匹配（典型场景是 Service Worker 缓存了旧页面），
    // 这里能立刻发现并提示刷新，而不是让后面的绑定静默失败。
    const missing = ids.filter((id) => !el[id]);
    if (missing.length) {
      console.error('[kunle] 页面元素缺失，可能存在新旧版本缓存不一致：', missing.join(', '));
      const bar = document.createElement('div');
      bar.className = 'version-banner';
      bar.innerHTML =
        '<span>页面可能被缓存为旧版本，功能会异常。</span>' +
        '<button type="button" class="btn btn-mini">强制刷新</button>';
      bar.querySelector('button').addEventListener('click', () => {
        if (navigator.serviceWorker) {
          navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
        }
        caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).finally(() => location.reload());
      });
      document.body.appendChild(bar);
    }
  }

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */
  let seq = 0;
  const uid = () => 'r' + ++seq;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  const fmtDur = (min) => window.KunleAlgo.formatMinutes(min);
  const money = (v) => (v == null ? '—' : '¥' + Math.round(v * 10) / 10);

  function setStatus(html, kind) {
    if (!html) {
      el.status.hidden = true;
      el.status.className = 'status';
      el.status.innerHTML = '';
      return;
    }
    el.status.hidden = false;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
    el.status.innerHTML = html;
  }

  function setOcrStatus(html, kind) {
    if (!html) {
      el.ocrStatus.hidden = true;
      el.ocrStatus.innerHTML = '';
      return;
    }
    el.ocrStatus.hidden = false;
    el.ocrStatus.className = 'status status-inline' + (kind ? ' is-' + kind : '');
    el.ocrStatus.innerHTML = html;
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ------------------------------------------------------------------ *
   * 版本自检与强制更新
   *
   * 背景：GitHub Pages 给静态文件打 max-age=600，Service Worker 又会缓存整套
   * 资源，容易出现「代码已更新、浏览器还在跑旧版」。这里做两件事：
   *   1. 启动时比对 version.json，不一致就清缓存重载（每会话最多一次，防循环）
   *   2. 头部 ⟳ 按钮：手动一键清缓存并更新
   * ------------------------------------------------------------------ */
  async function hardReset(reason) {
    try {
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      /* 尽力而为，失败也继续跳转 */
    }
    const base = location.pathname.replace(/[^/]*$/, '');
    const url =
      base +
      'index.html?fresh=' +
      Date.now() +
      (reason ? '&reason=' + encodeURIComponent(reason) : '');
    location.replace(url);
  }

  async function checkVersion() {
    try {
      const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return null;
      const remote = await res.json();
      if (!remote || !remote.version) return null;

      if (remote.version !== BUILD) {
        const key = 'kunle.versionReload';
        if (sessionStorage.getItem(key) === remote.version) return remote;
        sessionStorage.setItem(key, remote.version);
        setStatus(
          `检测到新版本 v${remote.version}（当前 v${BUILD}），正在清理缓存并自动更新…`,
          'loading'
        );
        await hardReset('auto');
        return remote;
      }
      return remote;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 行数据
   * ------------------------------------------------------------------ */
  function makeRow(data, group) {
    const d = data || {};
    const seatAvailable =
      d.seat && d.seat.available === false ? false : d.seatAvailable === false ? false : true;
    return {
      id: uid(),
      code: d.code || '',
      fromStation: d.fromStation || '',
      toStation: d.toStation || '',
      depart: d.depart || '',
      arrive: d.arrive || '',
      durationMin: d.durationMin == null ? '' : d.durationMin,
      price: d.price == null ? '' : d.price,
      seatText:
        d.seatText || (d.seat ? d.seat.name + (d.seat.text ? ' ' + d.seat.text : '') : ''),
      seatAvailable,
      group: group || d.group || 'direct',
    };
  }

  function addParsed(parsed, group) {
    if (!parsed || !parsed.length) return 0;
    for (const p of parsed) state.rows.push(makeRow(p, group));
    renderTable();
    return parsed.length;
  }

  function rowsOf(group) {
    return state.rows.filter((r) => r.group === group);
  }

  function renderTable() {
    if (!state.rows.length) {
      el.rowsBody.innerHTML = '';
      el.emptyHint.hidden = false;
    } else {
      el.emptyHint.hidden = true;
      el.rowsBody.innerHTML = state.rows
        .map(
          (r) => `<tr data-id="${r.id}">
            <td><input class="cell cell-code" data-field="code" value="${escapeHtml(r.code)}" placeholder="G1" /></td>
            <td><input class="cell" data-field="fromStation" value="${escapeHtml(r.fromStation)}" placeholder="出发站" /></td>
            <td><input class="cell" data-field="toStation" value="${escapeHtml(r.toStation)}" placeholder="到达站" /></td>
            <td><input class="cell cell-time" data-field="depart" value="${escapeHtml(r.depart)}" placeholder="06:30" /></td>
            <td><input class="cell cell-time" data-field="arrive" value="${escapeHtml(r.arrive)}" placeholder="11:24" /></td>
            <td><input class="cell cell-num" data-field="durationMin" type="number" value="${escapeHtml(r.durationMin)}" placeholder="294" /></td>
            <td><input class="cell cell-num" data-field="price" type="number" step="0.5" value="${escapeHtml(r.price)}" placeholder="598" /></td>
            <td><input class="cell cell-seat" data-field="seatText" value="${escapeHtml(r.seatText)}" placeholder="二等座 有" /></td>
            <td>
              <select class="cell cell-group" data-field="group">
                ${Object.entries(GROUPS)
                  .map(([k, v]) => `<option value="${k}" ${r.group === k ? 'selected' : ''}>${v}</option>`)
                  .join('')}
              </select>
            </td>
            <td><button class="row-del" data-del="${r.id}" title="删除这一行">✕</button></td>
          </tr>`
        )
        .join('');
    }
    updateCounts();
  }

  function updateCounts() {
    const c = { direct: 0, leg1: 0, leg2: 0, leg3: 0 };
    for (const r of state.rows) c[r.group] = (c[r.group] || 0) + 1;
    el.computeBtn.textContent = state.rows.length
      ? `计算最优方案（${c.direct} 直达 / ${c.leg1}·${c.leg2}·${c.leg3} 分段）`
      : '计算最优方案';
  }

  /* ------------------------------------------------------------------ *
   * 设置与主题
   * ------------------------------------------------------------------ */
  const THEME_ORDER = ['auto', 'light', 'dark'];
  const THEME_ICON = { auto: '🌓', light: '☀️', dark: '🌙' };

  function applyTheme(mode) {
    const m = THEME_ORDER.includes(mode) ? mode : 'auto';
    if (m === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', m);
    el.themeBtn.textContent = THEME_ICON[m];
    el.themeBtn.title = `主题：${m === 'auto' ? '跟随系统' : m === 'light' ? '浅色' : '深色'}（点击切换）`;
  }

  function cycleTheme() {
    const cur = state.settings.theme || 'auto';
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    state.settings = window.KunleStore.saveSettings({ theme: next });
    applyTheme(next);
    if (state.chart) state.chart.render();
  }

  function loadSettingsIntoUI() {
    const s = state.settings;
    state.weight = s.weight;
    el.weightInput.value = String(s.weight);
    el.weightOut.textContent = `${s.weight}% 省钱`;
    el.minTransfer.value = String(s.minTransfer);
    el.maxWait.value = String(s.maxWait);
    el.hubInput.value = s.hub || '';
    el.maxLegs.value = String(s.maxLegs == null ? 2 : s.maxLegs);

    const f = s.filters || {};
    el.fSeat.value = f.seatKeyword || '';
    el.fDepartFrom.value = f.departFrom || '';
    el.fDepartTo.value = f.departTo || '';
    el.fMaxPrice.value = f.maxPrice == null ? '' : f.maxPrice;
    el.fMaxDuration.value = f.maxDuration == null ? '' : f.maxDuration;
    el.fMaxTransfers.value = f.maxTransfers == null ? '' : String(f.maxTransfers);
    el.fExcludeOvernight.checked = Boolean(f.excludeOvernight);
    el.onlyBuyable.checked = Boolean(f.onlyBuyable);
    el.onlyDirect.checked = Boolean(f.onlyDirect);

    applyTheme(s.theme || 'auto');
  }

  function persistSettings(patch) {
    state.settings = window.KunleStore.saveSettings(patch);
  }

  function readFilters() {
    return {
      onlyBuyable: el.onlyBuyable.checked,
      onlyDirect: el.onlyDirect.checked,
      seatKeyword: el.fSeat.value.trim(),
      departFrom: el.fDepartFrom.value.trim(),
      departTo: el.fDepartTo.value.trim(),
      maxPrice: el.fMaxPrice.value === '' ? null : Number(el.fMaxPrice.value),
      maxDuration: el.fMaxDuration.value === '' ? null : Number(el.fMaxDuration.value),
      maxTransfers: el.fMaxTransfers.value === '' ? null : Number(el.fMaxTransfers.value),
      excludeOvernight: el.fExcludeOvernight.checked,
    };
  }

  /* ------------------------------------------------------------------ *
   * OCR
   * ------------------------------------------------------------------ */
  async function ocrImage(file) {
    if (window.__KUNLE_STANDALONE__) {
      setOcrStatus(
        '离线单文件版没有截图识别（识别需要本机 Windows OCR 服务）。请改用「粘贴文本」或「导入 CSV」。',
        'error'
      );
      return;
    }
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name || '')) {
      setOcrStatus('请选择图片文件（png / jpg / webp / bmp）', 'error');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setOcrStatus('图片太大（超过 12MB），请压缩或裁剪后再试', 'error');
      return;
    }

    setOcrStatus('<span class="spinner"></span>正在本地识别截图…', 'loading');
    try {
      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'image/png' },
        body: file,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '识别失败');

      const parsed = window.KunleParse.fromOcrLines(data.lines || []);
      if (!parsed.length) {
        setOcrStatus(
          '没有从这张图里识别出车次。建议：截图时保留「车次 + 时间 + 票价」整行，或改用「粘贴文本」。',
          'error'
        );
        return;
      }
      const n = addParsed(parsed, 'direct');
      setOcrStatus(
        `识别完成：从 ${data.lines.length} 段文字中解析出 ${n} 趟车次，请在表格里核对修正（OCR 可能有错字）。`
      );
    } catch (err) {
      setOcrStatus(
        `识别失败：${escapeHtml(err.message || err)}<br><span class="muted small">` +
          'OCR 依赖本机 Node 服务，请确认已运行 <code>node server/server.mjs</code>。' +
          '</span>',
        'error'
      );
    }
  }

  /* ------------------------------------------------------------------ *
   * 计算
   * ------------------------------------------------------------------ */
  function compute() {
    if (!state.rows.length) {
      setStatus('请先录入至少一趟车次（截图识别、粘贴文本、导入 CSV 或手动添加）。', 'error');
      return;
    }

    const maxLegs = Number(el.maxLegs.value) || 2;
    const groups = [rowsOf('direct'), rowsOf('leg1'), rowsOf('leg2'), rowsOf('leg3')].slice(
      0,
      maxLegs + 1
    );

    const { options, warnings } = window.KunleAlgo.buildChains(groups, {
      minTransfer: Number(el.minTransfer.value) || 30,
      maxWait: Number(el.maxWait.value) || 480,
      maxLegs,
    });

    if (!options.length) {
      setStatus(
        '没有可计算的方案。请检查：发车/到达时间是否填写、历时能否推算，或换乘时间是否放得太宽/太窄。' +
          (warnings.length ? '<br>' + warnings.map(escapeHtml).join('<br>') : ''),
        'error'
      );
      return;
    }

    const hubLabel = el.hubInput.value.trim();
    if (hubLabel) {
      for (const o of options) {
        if (o.transferCount === 1) o.hub = hubLabel;
      }
    }

    state.options = window.KunleAlgo.score(options, state.weight);
    state.filtered = window.KunleAlgo.applyFilters(state.options, readFilters());

    renderStats();
    renderRecommend();
    renderChart();
    renderList();
    renderIssues();

    const s = window.KunleAlgo.stats(state.options);
    setStatus(
      `已计算 ${s.count} 个方案（直达 ${s.directCount} · 一次中转 ${s.transferCount} · 两次中转 ${s.doubleTransferCount}）。` +
        (s.unknownPriceCount ? ` 其中 ${s.unknownPriceCount} 个未填票价，不参与比价。` : '') +
        (warnings.length
          ? `<br><span class="muted small">${warnings.map(escapeHtml).join(' ')}</span>`
          : '')
    );

    el.results.hidden = false;
    el.statsBar.hidden = false;

    if (state.a11y) {
      state.a11y.announce(
        `已生成 ${s.count} 个方案，最低价 ${s.minPrice == null ? '未知' : '¥' + s.minPrice}，最短耗时 ${fmtDur(
          s.minDuration
        )}`
      );
    }

    persistSettings({
      weight: state.weight,
      minTransfer: Number(el.minTransfer.value),
      maxWait: Number(el.maxWait.value),
      hub: hubLabel,
      maxLegs,
      filters: readFilters(),
    });

    saveHistorySnapshot();
  }

  /* ------------------------------------------------------------------ *
   * 渲染：统计
   * ------------------------------------------------------------------ */
  function renderStats() {
    const s = window.KunleAlgo.stats(state.options);
    el.stCount.textContent = `${s.count}（含 ${s.paretoCount} 前沿）`;
    el.stPrice.textContent = s.minPrice == null ? '—' : `${money(s.minPrice)} ~ ${money(s.maxPrice)}`;
    el.stTime.textContent = s.minDuration == null ? '—' : fmtDur(s.minDuration);

    if (s.savedVsCheapestDirect == null) {
      el.stSaved.textContent = '—';
      el.stSaved.className = '';
    } else if (s.savedVsCheapestDirect > 0.01) {
      el.stSaved.textContent = `省 ${money(s.savedVsCheapestDirect)}`;
      el.stSaved.className = 'is-good';
    } else if (s.savedVsCheapestDirect < -0.01) {
      el.stSaved.textContent = `贵 ${money(-s.savedVsCheapestDirect)}`;
      el.stSaved.className = 'is-bad';
    } else {
      el.stSaved.textContent = '持平';
      el.stSaved.className = '';
    }

    el.stPareto.textContent = s.paretoCount + ' 个';
    el.statsBar.hidden = false;
  }

  /* ------------------------------------------------------------------ *
   * 渲染：推荐
   * ------------------------------------------------------------------ */
  function routeText(o) {
    if (o.transferCount === 0) return `${o.fromStation || '?'} → ${o.toStation || '?'}`;
    const stops = [
      o.legs[0].from,
      ...o.legs.slice(0, -1).map((l) => l.to),
      o.legs[o.legs.length - 1].to,
    ];
    return stops.filter(Boolean).join(' → ');
  }

  function renderRecommend() {
    const recs = window.KunleAlgo.recommend(state.options, state.weight);
    if (!recs.length) {
      el.recommend.hidden = true;
      return;
    }
    el.recommendGrid.innerHTML = recs
      .map(
        ({ card, tag, data, note }) => `<div class="rec-card ${card}">
          <span class="rec-tag">${escapeHtml(tag)}</span>
          <div class="rec-main">${money(data.price)}<small>${
            data.transferCount ? ' 合计' : ''
          }</small></div>
          <div class="rec-sub">${escapeHtml(data.code)} · ${fmtDur(data.durationMin)} · ${escapeHtml(
            data.depart
          )} 发车</div>
          <div class="rec-sub">${escapeHtml(routeText(data))}</div>
          <div class="rec-sub muted">${escapeHtml(note)}</div>
        </div>`
      )
      .join('');
    el.recommend.hidden = false;
  }

  /* ------------------------------------------------------------------ *
   * 渲染：图表
   * ------------------------------------------------------------------ */
  function renderChart() {
    el.chartCard.hidden = false;
    if (!state.chart) {
      state.chart = window.KunleChart.createChart(el.chartCanvas, {
        onSelect: (option) => {
          renderDetail(option);
          el.chartHint.textContent = `已展开 ${option.code} 的行程详情，点击列表项也能查看。`;
        },
      });
    }
    state.chart.setData(state.filtered.length ? state.filtered : state.options);
  }

  /* ------------------------------------------------------------------ *
   * 渲染：列表
   * ------------------------------------------------------------------ */
  function sortedOptions(list) {
    const copy = [...list];
    if (state.sort === 'price') copy.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    else if (state.sort === 'time') copy.sort((a, b) => a.durationMin - b.durationMin);
    else if (state.sort === 'depart')
      copy.sort((a, b) => (a.departMin ?? Infinity) - (b.departMin ?? Infinity));
    else copy.sort((a, b) => a.score - b.score);
    return copy;
  }

  function itemHtml(o) {
    const typePill =
      o.transferCount === 0
        ? '<span class="type-pill">直达</span>'
        : `<span class="type-pill is-transfer">${
            o.transferCount === 1 ? '中转' : '两次中转'
          }${o.hub ? ' · ' + escapeHtml(o.hub) : ''}</span>`;
    const paretoPill = o.pareto ? '<span class="pareto-pill">性价比前沿</span>' : '';

    let legs = '';
    if (o.transferCount > 0) {
      legs =
        '<ul class="legs">' +
        o.legs
          .map(
            (l, i) =>
              `<li>第${i + 1}程 <b>${escapeHtml(l.code)}</b> ${escapeHtml(l.from)} ${escapeHtml(
                l.depart
              )} → ${escapeHtml(l.to)} ${escapeHtml(l.arrive)}${
                l.price != null ? ' · ' + money(l.price) : ''
              }</li>`
          )
          .join('') +
        o.waits
          .map((w, i) => `<li class="wait-tip">在第 ${i + 1} 个中转站等待 ${fmtDur(w)}</li>`)
          .join('') +
        '</ul>';
    }

    const seat =
      o.transferCount === 0 && o.seatText
        ? `<div class="seats"><span class="seat-chip">${escapeHtml(o.seatText)}</span></div>`
        : '';

    const priceHtml =
      o.price == null
        ? '<div class="price is-unknown">未填票价</div>'
        : `<div class="price">${money(o.price)}<small>${o.transferCount ? ' 合计' : ''}</small></div>`;

    return `<article class="item ${o.pareto ? 'is-pareto' : ''}" id="opt-${escapeHtml(o.key)}">
      <div>
        <div class="item-head">
          <span class="train-code">${escapeHtml(o.code)}</span>
          ${typePill}${paretoPill}
        </div>
        <div class="timeline">
          <span class="tm">${escapeHtml(o.depart)}</span>
          <span class="st">${escapeHtml(o.fromStation)}</span>
          <span class="arrow">──${fmtDur(o.durationMin)}──▶</span>
          <span class="tm">${escapeHtml(o.arrive)}</span>
          <span class="st">${escapeHtml(o.toStation)}</span>
        </div>
        ${legs}${seat}
      </div>
      <div class="price-box">${priceHtml}</div>
    </article>`;
  }

  function renderList() {
    const list = sortedOptions(state.filtered);
    el.countInfo.textContent = `显示 ${list.length} / 共 ${state.options.length} 个方案 · 排序：${
      SORT_LABEL[state.sort]
    }`;
    el.list.innerHTML = list.length
      ? list.map(itemHtml).join('')
      : '<p class="muted">当前筛选条件下没有方案，试试放宽条件或重置筛选。</p>';
  }

  /* ------------------------------------------------------------------ *
   * 行程详情（时间轴）
   * ------------------------------------------------------------------ */
  function renderDetail(option) {
    if (!option) return;
    el.detailTitle.textContent = `${option.code} 行程详情`;
    el.detailCard.hidden = false;

    if (window.KunleTimeline) {
      window.KunleTimeline.render(el.detailTimeline, option);
    }

    const rows = [];
    rows.push(['路线', escapeHtml(routeText(option))]);
    rows.push(['时刻', `${escapeHtml(option.depart)} → ${escapeHtml(option.arrive)}`]);
    rows.push(['总耗时', fmtDur(option.durationMin)]);
    rows.push(['总价', money(option.price)]);
    rows.push([
      '中转',
      option.transferCount === 0
        ? '直达'
        : `${option.transferCount} 次（等待 ${fmtDur(option.waitMin)}）`,
    ]);
    if (option.seatText) rows.push(['席别余票', escapeHtml(option.seatText)]);
    if (option.pareto) rows.push(['性价比', '位于前沿（没有被更便宜又更快的方案压制）']);

    const legsHtml =
      option.legs && option.legs.length > 1
        ? `<div class="detail-row"><span class="k">分段</span><span class="v"><ul class="detail-legs">${option.legs
            .map(
              (l, i) =>
                `<li>${i + 1}. ${escapeHtml(l.code)} ${escapeHtml(l.from)} ${escapeHtml(
                  l.depart
                )} → ${escapeHtml(l.to)} ${escapeHtml(l.arrive)} · ${money(l.price)}</li>`
            )
            .join('')}</ul></span></div>`
        : '';

    el.detailBody.innerHTML =
      rows
        .map(([k, v]) => `<div class="detail-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
        .join('') + legsHtml;

    if (state.a11y) state.a11y.announce(`已展开 ${option.code} 的行程详情`);
  }


  function renderIssues() {
    if (!window.KunleValidate) return;
    const { issues, summary, hasBlocking } = window.KunleValidate.validateRows(state.rows, {
      hub: el.hubInput.value,
    });

    if (!issues.length) {
      el.issuesCard.hidden = true;
      return;
    }
    el.issuesCard.hidden = false;
    el.issuesSummary.textContent = `${hasBlocking ? '存在阻断问题 · ' : ''}错误 ${summary.error} · 警告 ${
      summary.warn
    } · 提示 ${summary.info}`;

    const icon = { error: '✕', warn: '!', info: 'i' };
    const label = { error: '错误', warn: '警告', info: '提示' };
    el.issuesList.innerHTML = issues
      .slice(0, 40)
      .map(
        (i) => `<li class="lv-${i.level}">
          <span class="lv-tag">${icon[i.level]} ${label[i.level]}</span>
          <span>${escapeHtml(i.message)}</span>
        </li>`
      )
      .join('');
  }

  /* ------------------------------------------------------------------ *
   * 报告导出
   * ------------------------------------------------------------------ */
  function reportContext() {
    return {
      weight: state.weight,
      minTransfer: Number(el.minTransfer.value),
      maxWait: Number(el.maxWait.value),
      maxLegs: Number(el.maxLegs.value),
      hub: el.hubInput.value.trim(),
      generatedAt: new Date().toISOString(),
    };
  }

  function exportReport(format) {
    if (!state.options.length) {
      setStatus('请先计算方案再导出报告。', 'error');
      return;
    }
    const ctx = reportContext();
    const list = sortedOptions(state.filtered.length ? state.filtered : state.options);

    if (format === 'md') {
      const md = window.KunleReport.markdown(list, ctx);
      download(window.KunleReport.fileName('md'), md, 'text/markdown;charset=utf-8');
    } else {
      const page = window.KunleReport.html(list, ctx);
      download(window.KunleReport.fileName('html'), page, 'text/html;charset=utf-8');
    }
    setStatus(`已导出${format === 'md' ? ' Markdown ' : ' HTML '}报告，可在浏览器或编辑器中打开。`);
  }

  /* ------------------------------------------------------------------ *
   * 历史记录
   * ------------------------------------------------------------------ */
  function saveHistorySnapshot() {
    const s = window.KunleAlgo.stats(state.options);
    const plainRows = state.rows.map((r) => ({
      code: r.code,
      fromStation: r.fromStation,
      toStation: r.toStation,
      depart: r.depart,
      arrive: r.arrive,
      durationMin: r.durationMin,
      price: r.price,
      seatText: r.seatText,
      seatAvailable: r.seatAvailable,
      group: r.group,
    }));

    // 相同数据连续计算时不重复记一条历史
    const signature = JSON.stringify([plainRows, state.weight, el.maxLegs.value]);
    const last = window.KunleStore.loadHistory()[0];
    if (last && last.signature === signature) {
      renderHistory();
      return;
    }

    window.KunleStore.saveSnapshot({
      rows: plainRows,
      hub: el.hubInput.value,
      weight: state.weight,
      minTransfer: Number(el.minTransfer.value),
      maxWait: Number(el.maxWait.value),
      maxLegs: Number(el.maxLegs.value),
      summary: { options: s.count, minPrice: s.minPrice, minDuration: s.minDuration },
      signature,
    });
    renderHistory();
  }

  function renderHistory() {
    const list = window.KunleStore.loadHistory();
    state.history = list;
    el.historyCard.hidden = list.length === 0;
    el.historyList.innerHTML = list
      .map((h) => {
        const time = new Date(h.createdAt).toLocaleString('zh-CN');
        const sum = h.summary || {};
        return `<div class="history-item">
          <span class="h-time">${escapeHtml(time)}</span>
          <span class="h-sum">
            ${h.rows.length} 条车次 · ${sum.options || 0} 个方案 · 最低 ${
              sum.minPrice == null ? '—' : money(sum.minPrice)
            }${h.hub ? ' · 中转 ' + escapeHtml(h.hub) : ''}
          </span>
          <span class="h-actions">
            <button class="btn btn-mini" data-restore="${h.id}" type="button">回填</button>
            <button class="btn btn-mini btn-danger" data-remove="${h.id}" type="button">删除</button>
          </span>
        </div>`;
      })
      .join('');
  }

  function restoreSnapshot(id) {
    const h = window.KunleStore.loadHistory().find((x) => x.id === id);
    if (!h) return;
    state.rows = [];
    seq = 0;
    for (const r of h.rows) state.rows.push(makeRow(r, r.group));
    el.hubInput.value = h.hub || '';
    if (h.weight != null) {
      state.weight = h.weight;
      el.weightInput.value = String(h.weight);
      el.weightOut.textContent = `${h.weight}% 省钱`;
    }
    if (h.minTransfer != null) el.minTransfer.value = String(h.minTransfer);
    if (h.maxWait != null) el.maxWait.value = String(h.maxWait);
    if (h.maxLegs != null) el.maxLegs.value = String(h.maxLegs);

    // 清掉上一轮的旧结果，避免看成是这次的数据
    state.options = [];
    state.filtered = [];
    el.results.hidden = true;
    el.recommend.hidden = true;
    el.statsBar.hidden = true;
    el.chartCard.hidden = true;
    el.detailCard.hidden = true;
    el.issuesCard.hidden = true;

    renderTable();
    setStatus('已回填一条历史记录，点「计算最优方案」重新计算。');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ------------------------------------------------------------------ *
   * CSV
   * ------------------------------------------------------------------ */
  function exportCsv() {
    if (!state.rows.length) {
      setOcrStatus('还没有数据可导出。', 'error');
      return;
    }
    const csv = window.KunleParse.toCSV(state.rows);
    download(
      `kunle-车次-${new Date().toISOString().slice(0, 10)}.csv`,
      '\uFEFF' + csv,
      'text/csv;charset=utf-8'
    );
    setOcrStatus(`已导出 ${state.rows.length} 行车次（含 UTF-8 BOM，Excel 可直接打开）。`);
  }

  async function importCsv(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const rows = window.KunleParse.fromCSV(text);
      if (!rows.length) {
        setOcrStatus('CSV 里没有解析出车次，请确认至少包含「车次」列。', 'error');
        return;
      }
      const n = addParsed(rows, 'direct');
      setOcrStatus(`CSV 导入完成：新增 ${n} 行。`);
    } catch (err) {
      setOcrStatus('CSV 导入失败：' + escapeHtml(err.message || err), 'error');
    }
  }

  /* ------------------------------------------------------------------ *
   * 打印
   * ------------------------------------------------------------------ */
  function buildPrintArea() {
    const s = window.KunleAlgo.stats(state.options);
    const recs = window.KunleAlgo.recommend(state.options, state.weight);
    const source = state.filtered.length ? state.filtered : state.options;
    const top = sortedOptions(source).slice(0, 20);

    const recHtml = recs
      .map(
        (r) =>
          `<div class="p-rec"><b>${escapeHtml(r.tag)}</b><br>
            ${escapeHtml(r.data.code)} · ${money(r.data.price)} · ${fmtDur(r.data.durationMin)}<br>
            ${escapeHtml(routeText(r.data))} · ${escapeHtml(r.data.depart)} 发车</div>`
      )
      .join('');

    const tableRows = top
      .map(
        (o, i) => `<tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(o.code)}</td>
          <td>${escapeHtml(routeText(o))}</td>
          <td>${escapeHtml(o.depart)} → ${escapeHtml(o.arrive)}</td>
          <td>${fmtDur(o.durationMin)}</td>
          <td>${o.transferCount === 0 ? '直达' : o.transferCount + ' 次'}</td>
          <td>${money(o.price)}</td>
          <td>${o.pareto ? '★' : ''}</td>
        </tr>`
      )
      .join('');

    el.printArea.innerHTML = `
      <h1>车票最优方案单</h1>
      <div class="p-meta">
        生成时间：${new Date().toLocaleString('zh-CN')} ｜
        参数：权重 ${state.weight}% 省钱 · 最少换乘 ${el.minTransfer.value} 分钟 · 最多 ${el.maxLegs.value} 段
      </div>
      ${recHtml}
      <div class="p-meta">
        共 ${s.count} 个方案（直达 ${s.directCount}、一次中转 ${s.transferCount}、两次中转 ${s.doubleTransferCount}），
        价格 ${s.minPrice == null ? '—' : money(s.minPrice) + ' ~ ' + money(s.maxPrice)}，
        最短耗时 ${fmtDur(s.minDuration)}。下表列出前 ${top.length} 个。
      </div>
      <table>
        <thead>
          <tr><th>#</th><th>车次</th><th>路线</th><th>时间</th><th>耗时</th><th>中转</th><th>票价</th><th>前沿</th></tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <div class="p-meta">票价与余票请以 12306 官方页面为准。</div>
    `;
  }

  function doPrint() {
    if (!state.options.length) {
      setStatus('请先计算方案再打印。', 'error');
      return;
    }
    buildPrintArea();
    window.print();
  }

  /* ------------------------------------------------------------------ *
   * 示例数据
   * ------------------------------------------------------------------ */
  const DEMO = {
    direct: [
      { code: 'G1', fromStation: '北京南', toStation: '上海虹桥', depart: '06:30', arrive: '11:24', durationMin: 294, price: 598, seat: { name: '二等座', text: '有' } },
      { code: 'G3', fromStation: '北京南', toStation: '上海虹桥', depart: '07:00', arrive: '11:41', durationMin: 281, price: 667, seat: { name: '二等座', text: '有' } },
      { code: 'G531', fromStation: '北京南', toStation: '上海虹桥', depart: '06:08', arrive: '12:04', durationMin: 356, price: 498, seat: { name: '二等座', text: '2' } },
      { code: 'D709', fromStation: '北京南', toStation: '上海虹桥', depart: '19:46', arrive: '07:45', durationMin: 719, price: 296, seat: { name: '二等座', text: '有' } },
      { code: '1461', fromStation: '北京', toStation: '上海', depart: '11:59', arrive: '06:45', durationMin: 1126, price: 156.5, seat: { name: '硬座', text: '有' } },
    ],
    leg1: [
      { code: 'G801', fromStation: '北京南', toStation: '郑州东', depart: '07:00', arrive: '09:30', durationMin: 150, price: 309, seat: { name: '二等座', text: '有' } },
      { code: 'G803', fromStation: '北京南', toStation: '郑州东', depart: '08:00', arrive: '10:40', durationMin: 160, price: 309, seat: { name: '二等座', text: '有' } },
    ],
    leg2: [
      { code: 'G1801', fromStation: '郑州东', toStation: '南京南', depart: '11:10', arrive: '15:00', durationMin: 230, price: 230, seat: { name: '二等座', text: '有' } },
      { code: 'G1803', fromStation: '郑州东', toStation: '南京南', depart: '12:20', arrive: '16:10', durationMin: 230, price: 230, seat: { name: '二等座', text: '有' } },
    ],
    leg3: [
      { code: 'G35', fromStation: '南京南', toStation: '上海虹桥', depart: '17:00', arrive: '18:00', durationMin: 60, price: 146, seat: { name: '二等座', text: '有' } },
      { code: 'G459', fromStation: '南京南', toStation: '上海虹桥', depart: '18:30', arrive: '19:34', durationMin: 64, price: 146, seat: { name: '二等座', text: '有' } },
    ],
  };

  function loadDemo() {
    state.rows = [];
    for (const [group, list] of Object.entries(DEMO)) {
      for (const item of list) state.rows.push(makeRow(item, group));
    }
    el.hubInput.value = '郑州 / 南京';
    el.maxLegs.value = '3';
    renderTable();
    setOcrStatus(
      '已载入示例：5 趟直达 + 郑州、南京两处中转车次。点「计算最优方案」查看直达 / 一次中转 / 两次中转的差异。'
    );
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */
  function bind() {
    /* --- 表格编辑 --- */
    el.rowsBody.addEventListener('input', (e) => {
      const input = e.target;
      const tr = input.closest('tr');
      if (!tr) return;
      const row = state.rows.find((r) => r.id === tr.dataset.id);
      if (!row) return;
      const field = input.dataset.field;
      if (field) row[field] = input.value;
    });

    el.rowsBody.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-field="group"]');
      if (!sel) return;
      const row = state.rows.find((r) => r.id === sel.closest('tr').dataset.id);
      if (row) row.group = sel.value;
      updateCounts();
    });

    el.rowsBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      state.rows = state.rows.filter((r) => r.id !== btn.dataset.del);
      renderTable();
    });

    document.querySelectorAll('[data-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const g = btn.dataset.group;
        for (const r of state.rows) r.group = g;
        renderTable();
      });
    });

    el.addRowBtn.addEventListener('click', () => {
      state.rows.push(makeRow({}, 'direct'));
      renderTable();
    });

    el.clearBtn.addEventListener('click', () => {
      state.rows = [];
      state.options = [];
      state.filtered = [];
      renderTable();
      el.results.hidden = true;
      el.recommend.hidden = true;
      el.statsBar.hidden = true;
      el.chartCard.hidden = true;
      el.detailCard.hidden = true;
      el.issuesCard.hidden = true;
      setStatus('');
      setOcrStatus('');
    });

    el.demoBtn.addEventListener('click', loadDemo);

    /* --- 截图 --- */
    el.dropzone.addEventListener('click', () => el.fileInput.click());
    el.dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.fileInput.click();
      }
    });
    el.fileInput.addEventListener('change', () => {
      if (el.fileInput.files && el.fileInput.files[0]) ocrImage(el.fileInput.files[0]);
      el.fileInput.value = '';
    });
    el.dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.dropzone.classList.add('is-drag');
    });
    el.dropzone.addEventListener('dragleave', () => el.dropzone.classList.remove('is-drag'));
    el.dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      el.dropzone.classList.remove('is-drag');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) ocrImage(f);
    });

    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.indexOf('image') === 0) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            ocrImage(f);
            return;
          }
        }
      }
    });

    /* --- 文本 / CSV --- */
    el.parseTextBtn.addEventListener('click', () => {
      const text = el.pasteArea.value;
      if (!text.trim()) {
        setOcrStatus('文本框是空的，先粘贴几行车次信息。', 'error');
        return;
      }
      const parsed = window.KunleParse.fromText(text);
      if (!parsed.length) {
        setOcrStatus('没解析出车次。每行至少包含车次号，例如：G1 北京南 上海虹桥 06:30 11:24 ¥598', 'error');
        return;
      }
      const n = addParsed(parsed, 'direct');
      setOcrStatus(`文本解析完成：新增 ${n} 趟车次。`);
      el.pasteArea.value = '';
    });

    el.csvImportBtn.addEventListener('click', () => el.csvFileInput.click());
    el.csvFileInput.addEventListener('change', () => {
      if (el.csvFileInput.files && el.csvFileInput.files[0]) importCsv(el.csvFileInput.files[0]);
      el.csvFileInput.value = '';
    });
    el.csvExportBtn.addEventListener('click', exportCsv);

    /* --- 参数 --- */
    el.weightInput.addEventListener('input', () => {
      state.weight = Number(el.weightInput.value);
      el.weightOut.textContent = `${state.weight}% 省钱`;
      if (state.options.length) {
        window.KunleAlgo.score(state.options, state.weight);
        state.filtered = window.KunleAlgo.applyFilters(state.options, readFilters());
        renderStats();
        renderRecommend();
        renderChart();
        renderList();
      }
      persistSettings({ weight: state.weight });
    });

    el.computeBtn.addEventListener('click', compute);

    [el.minTransfer, el.maxWait, el.maxLegs].forEach((input) => {
      input.addEventListener('change', () => {
        persistSettings({
          minTransfer: Number(el.minTransfer.value),
          maxWait: Number(el.maxWait.value),
          maxLegs: Number(el.maxLegs.value),
        });
      });
    });

    el.hubInput.addEventListener('change', () => persistSettings({ hub: el.hubInput.value }));

    /* --- 筛选 --- */
    const onFilter = () => {
      persistSettings({ filters: readFilters() });
      if (state.options.length) {
        state.filtered = window.KunleAlgo.applyFilters(state.options, readFilters());
        renderChart();
        renderList();
      }
    };
    [el.fSeat, el.fDepartFrom, el.fDepartTo, el.fMaxPrice, el.fMaxDuration, el.fMaxTransfers].forEach(
      (input) => input.addEventListener('change', onFilter)
    );
    el.fExcludeOvernight.addEventListener('change', onFilter);
    el.onlyBuyable.addEventListener('change', onFilter);
    el.onlyDirect.addEventListener('change', onFilter);

    el.resetFiltersBtn.addEventListener('click', () => {
      el.fSeat.value = '';
      el.fDepartFrom.value = '';
      el.fDepartTo.value = '';
      el.fMaxPrice.value = '';
      el.fMaxDuration.value = '';
      el.fMaxTransfers.value = '';
      el.fExcludeOvernight.checked = false;
      el.onlyBuyable.checked = false;
      el.onlyDirect.checked = false;
      onFilter();
    });

    el.filterToggle.addEventListener('click', () => {
      const collapsed = el.filterPanel.classList.toggle('is-collapsed');
      el.filterToggle.textContent = collapsed ? '展开' : '收起';
    });

    /* --- 排序 --- */
    el.sortTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      setSort(btn.dataset.sort);
    });

    /* --- 行程详情 --- */
    el.list.addEventListener('click', (e) => {
      const article = e.target.closest('.item');
      if (!article) return;
      const option = state.options.find((o) => 'opt-' + o.key === article.id);
      if (option) renderDetail(option);
    });
    el.detailClose.addEventListener('click', () => {
      el.detailCard.hidden = true;
    });

    /* --- 历史 --- */
    el.historyList.addEventListener('click', (e) => {
      const restore = e.target.closest('[data-restore]');
      if (restore) return restoreSnapshot(restore.dataset.restore);
      const remove = e.target.closest('[data-remove]');
      if (remove) {
        window.KunleStore.removeSnapshot(remove.dataset.remove);
        renderHistory();
      }
    });
    el.historyClear.addEventListener('click', () => {
      window.KunleStore.clearHistory();
      renderHistory();
    });

    /* --- 主题 / 打印 / 强制更新 --- */
    el.themeBtn.addEventListener('click', cycleTheme);
    el.printBtn.addEventListener('click', doPrint);
    el.hardResetBtn.addEventListener('click', () => {
      setStatus('正在清除缓存并更新到最新版…', 'loading');
      hardReset('manual');
    });

    /* --- 报告导出 --- */
    el.exportMdBtn.addEventListener('click', () => exportReport('md'));
    el.exportHtmlBtn.addEventListener('click', () => exportReport('html'));
  }

  /* ------------------------------------------------------------------ *
   * 排序与无障碍
   * ------------------------------------------------------------------ */
  function setSort(key) {
    const btn = [...el.sortTabs.children].find((b) => b.dataset.sort === key);
    if (!btn) return;
    [...el.sortTabs.children].forEach((b) => b.classList.toggle('is-active', b === btn));
    state.sort = key;
    if (state.options.length) renderList();
  }

  function initA11y() {
    if (!window.KunleA11y) return;
    state.a11y = window.KunleA11y.init({
      shortcuts: {
        'ctrl+enter': () => compute(),
        'ctrl+e': () => exportReport('md'),
        'ctrl+p': () => doPrint(),
        'alt+1': () => setSort('score'),
        'alt+2': () => setSort('price'),
        'alt+3': () => setSort('time'),
        'alt+4': () => setSort('depart'),
        'alt+d': () => loadDemo(),
      },
      onEscape: () => {
        if (!el.detailCard.hidden) {
          el.detailCard.hidden = true;
          if (state.a11y) state.a11y.releaseFocus();
          return true;
        }
        return false;
      },
    });
    state.a11y.initTabs(el.sortTabs);
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  async function checkEngine() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data.ok && data.ocr) {
        el.engineBadge.textContent = '本地 OCR 已就绪';
        el.engineBadge.className = 'badge badge-ok';
      } else {
        el.engineBadge.textContent = 'OCR 不可用（可粘贴文本）';
        el.engineBadge.className = 'badge badge-err';
      }
    } catch {
      el.engineBadge.textContent = '未连接本地服务（可粘贴文本）';
      el.engineBadge.className = 'badge badge-err';
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

    // 首次访问时 controller 为空：此时 Service Worker 接管不应引发刷新，
    // 否则用户刚录入的数据会被整页重载清掉。
    const hadController = Boolean(navigator.serviceWorker.controller);

    navigator.serviceWorker
      .register('sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update().catch(() => {});
        // 长时间开着的页面也定期检查更新
        setInterval(() => reg.update().catch(() => {}), 60 * 1000);
      })
      .catch(() => {
        /* 离线缓存失败不影响主流程 */
      });

    // 只有在「已有一个控制器、又被新版本替换」时才刷新一次，避免新旧脚本混用
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
  }

  function boot() {
    cacheElements();
    state.settings = window.KunleStore.loadSettings();
    loadSettingsIntoUI();
    bind();
    initA11y();
    renderTable();
    renderHistory();

    const standalone = Boolean(window.__KUNLE_STANDALONE__);
    if (standalone) {
      el.engineBadge.textContent = '离线版 · 无 OCR';
      el.engineBadge.className = 'badge badge-muted';
      el.engineBadge.title = '单文件离线版：支持粘贴文本、CSV、计算、图表、报告；不支持截图识别';
      el.dropzone.classList.add('is-disabled');
      el.dropzone.setAttribute('aria-disabled', 'true');
      setOcrStatus(
        '当前是<b>离线单文件版</b>：没有截图识别，但粘贴文本 / CSV 导入 / 最优计算 / 图表 / 报告导出都能用。',
        ''
      );
    } else {
      checkEngine();
      registerServiceWorker();
      checkVersion();
    }

    el.buildInfo.textContent = `最后更新：${new Date(document.lastModified).toLocaleString('zh-CN')}`;
    if (el.versionTag) el.versionTag.textContent = `v${BUILD}`;

    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1') {
      loadDemo();
      setTimeout(compute, 80);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
