/**
 * app.js —— 界面控制
 *
 * 流程：录入截图/文本 → 本地 OCR（Windows 引擎）→ 解析成表格 → 人工核对 → 计算最优方案
 * 全程不联网抓取任何数据，只有图片送到本机的 Node 服务做 OCR。
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const GROUPS = {
    direct: '直达',
    leg1: '第一程',
    leg2: '第二程',
  };

  const state = {
    rows: [],
    options: [],
    sort: 'score',
    weight: 55,
    onlyBuyable: false,
    onlyDirect: false,
    busy: false,
  };

  const el = {
    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    pasteArea: $('pasteArea'),
    parseTextBtn: $('parseTextBtn'),
    ocrStatus: $('ocrStatus'),
    rowsBody: $('rowsBody'),
    emptyHint: $('emptyHint'),
    addRowBtn: $('addRowBtn'),
    demoBtn: $('demoBtn'),
    clearBtn: $('clearBtn'),
    hubInput: $('hubInput'),
    minTransfer: $('minTransfer'),
    maxWait: $('maxWait'),
    weight: $('weightInput'),
    weightOut: $('weightOut'),
    computeBtn: $('computeBtn'),
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
    engineBadge: $('engineBadge'),
    buildInfo: $('buildInfo'),
  };

  let seq = 0;
  const uid = () => 'r' + ++seq;

  /* ------------------------------------------------------------------ *
   * 通用工具
   * ------------------------------------------------------------------ */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function fmtDuration(min) {
    if (min == null) return '—';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}小时${String(m).padStart(2, '0')}分` : `${m}分`;
  }

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

  /* ------------------------------------------------------------------ *
   * 行数据管理
   * ------------------------------------------------------------------ */
  function makeRow(data, group) {
    const d = data || {};
    return {
      id: uid(),
      code: d.code || '',
      fromStation: d.fromStation || '',
      toStation: d.toStation || '',
      depart: d.depart || '',
      arrive: d.arrive || '',
      durationMin: d.durationMin == null ? '' : d.durationMin,
      price: d.price == null ? '' : d.price,
      seatText: d.seat ? d.seat.name + (d.seat.text ? ' ' + d.seat.text : '') : '',
      seatAvailable: d.seat && d.seat.available === false ? false : true,
      group: group || 'direct',
    };
  }

  function addParsed(parsed, group) {
    if (!parsed || !parsed.length) return 0;
    for (const p of parsed) state.rows.push(makeRow(p, group));
    renderTable();
    return parsed.length;
  }

  function renderTable() {
    if (!state.rows.length) {
      el.rowsBody.innerHTML = '';
      el.emptyHint.hidden = false;
    } else {
      el.emptyHint.hidden = true;
      el.rowsBody.innerHTML = state.rows
        .map(
          (r, i) => `<tr data-id="${r.id}">
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
    const c = { direct: 0, leg1: 0, leg2: 0 };
    for (const r of state.rows) c[r.group] = (c[r.group] || 0) + 1;
    el.computeBtn.textContent =
      state.rows.length
        ? `计算最优方案（${c.direct} 直达 / ${c.leg1} 第一程 / ${c.leg2} 第二程）`
        : '计算最优方案';
  }

  /* ------------------------------------------------------------------ *
   * OCR
   * ------------------------------------------------------------------ */
  async function ocrImage(file) {
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
          '没有从这张图里识别出车次。建议：截图时保留「车次 + 时间 + 票价」整行，或直接用「粘贴文本」。',
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
          'OCR 依赖本机 Node 服务，请确认已运行 <code>node server/server.mjs</code> 并通过 http://127.0.0.1:8787 打开本页面。' +
          '</span>',
        'error'
      );
    }
  }

  /* ------------------------------------------------------------------ *
   * 计算与渲染
   * ------------------------------------------------------------------ */
  function compute() {
    const directRows = state.rows.filter((r) => r.group === 'direct');
    const leg1Rows = state.rows.filter((r) => r.group === 'leg1');
    const leg2Rows = state.rows.filter((r) => r.group === 'leg2');

    if (!state.rows.length) {
      setStatus('请先录入至少一趟车次（截图识别、粘贴文本或手动添加）。', 'error');
      return;
    }
    if (!directRows.length && !(leg1Rows.length && leg2Rows.length)) {
      setStatus('需要「直达」车次，或者同时具备「第一程 + 第二程」才能计算中转方案。', 'error');
      return;
    }

    const { options, warnings } = window.KunleAlgo.buildOptions(directRows, leg1Rows, leg2Rows, {
      hub: el.hubInput.value,
      minTransfer: Number(el.minTransfer.value),
      maxWait: Number(el.maxWait.value),
    });

    if (!options.length) {
      setStatus(
        '没有可计算的方案。请检查：车次的发车/到达时间是否填写、历时是否能推算出来。' +
          (warnings.length ? '<br>' + warnings.map(escapeHtml).join('<br>') : ''),
        'error'
      );
      return;
    }

    state.options = window.KunleAlgo.score(options, state.weight);

    const directCount = state.options.filter((o) => o.kind === 'direct').length;
    const transferCount = state.options.length - directCount;
    const unknown = state.options.filter((o) => o.price == null).length;

    setStatus(
      `已计算 ${state.options.length} 个方案（直达 ${directCount} · 中转 ${transferCount}）。` +
        (unknown ? ` 其中 ${unknown} 个未填票价，不参与「最划算」比较。` : '') +
        (warnings.length ? `<br><span class="muted small">${warnings.map(escapeHtml).join(' ')}</span>` : '')
    );

    renderRecommend();
    renderList();
    el.results.hidden = false;
  }

  function renderRecommend() {
    const recs = window.KunleAlgo.recommend(state.options, state.weight);
    if (!recs.length) {
      el.recommend.hidden = true;
      return;
    }
    el.recommendGrid.innerHTML = recs
      .map(({ card, tag, data, note }) => {
        const route =
          data.kind === 'transfer'
            ? `${escapeHtml(data.legs[0].from)} → ${escapeHtml(data.hub)} → ${escapeHtml(data.legs[1].to)}`
            : `${escapeHtml(data.fromStation)} → ${escapeHtml(data.toStation)}`;
        return `<div class="rec-card ${card}">
          <span class="rec-tag">${escapeHtml(tag)}</span>
          <div class="rec-main">¥${data.price}<small>${data.kind === 'transfer' ? '两程合计' : ''}</small></div>
          <div class="rec-sub">${escapeHtml(data.code)} · ${fmtDuration(data.durationMin)} · ${escapeHtml(
            data.depart
          )} 发车</div>
          <div class="rec-sub">${route}</div>
          <div class="rec-sub muted">${escapeHtml(note)}</div>
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

  function sortedOptions(list) {
    const copy = [...list];
    if (state.sort === 'price') copy.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    else if (state.sort === 'time') copy.sort((a, b) => a.durationMin - b.durationMin);
    else if (state.sort === 'depart') copy.sort((a, b) => String(a.depart).localeCompare(String(b.depart)));
    else copy.sort((a, b) => a.score - b.score);
    return copy;
  }

  function renderItem(o) {
    const typePill =
      o.kind === 'transfer'
        ? `<span class="type-pill is-transfer">中转 · ${escapeHtml(o.hub)}</span>`
        : `<span class="type-pill">直达</span>`;
    const paretoPill = o.pareto ? `<span class="pareto-pill">性价比前沿</span>` : '';
    const legs =
      o.kind === 'transfer'
        ? `<ul class="legs">
            <li>第一程 ${escapeHtml(o.legs[0].code)} ${escapeHtml(o.legs[0].from)} ${escapeHtml(o.legs[0].depart)} → ${escapeHtml(o.legs[0].to)} ${escapeHtml(o.legs[0].arrive)} · ¥${o.legs[0].price ?? '—'}</li>
            <li class="wait-tip">在 ${escapeHtml(o.hub)} 等待 ${fmtDuration(o.waitMin)}（按你设置的最少换乘时间校验）</li>
            <li>第二程 ${escapeHtml(o.legs[1].code)} ${escapeHtml(o.legs[1].from)} ${escapeHtml(o.legs[1].depart)} → ${escapeHtml(o.legs[1].to)} ${escapeHtml(o.legs[1].arrive)} · ¥${o.legs[1].price ?? '—'}</li>
          </ul>`
        : '';
    const seat = o.kind === 'direct' && o.seatText ? `<div class="seats"><span class="seat-chip">${escapeHtml(o.seatText)}</span></div>` : '';
    const priceHtml =
      o.price == null
        ? `<div class="price is-unknown">未填票价</div>`
        : `<div class="price">¥${o.price}<small>${o.kind === 'transfer' ? ' 合计' : ''}</small></div>`;

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
          <span class="st">${escapeHtml(o.toStation)}</span>
        </div>
        ${legs}${seat}
      </div>
      <div class="price-box">${priceHtml}</div>
    </article>`;
  }

  function renderList() {
    const list = sortedOptions(visibleOptions());
    const directCount = state.options.filter((o) => o.kind === 'direct').length;
    el.countInfo.textContent = `共 ${state.options.length} 个方案（直达 ${directCount} · 中转 ${
      state.options.length - directCount
    }）`;
    el.list.innerHTML = list.length
      ? list.map(renderItem).join('')
      : '<p class="muted">当前筛选下没有方案。</p>';
  }

  /* ------------------------------------------------------------------ *
   * 示例数据（纯本地，便于快速体验）
   * ------------------------------------------------------------------ */
  const DEMO = {
    direct: [
      { code: 'G1', fromStation: '北京南', toStation: '上海虹桥', depart: '06:30', arrive: '11:24', durationMin: 294, price: 598, seat: { name: '二等座', text: '有', available: true } },
      { code: 'G3', fromStation: '北京南', toStation: '上海虹桥', depart: '07:00', arrive: '11:41', durationMin: 281, price: 667, seat: { name: '二等座', text: '有', available: true } },
      { code: 'G531', fromStation: '北京南', toStation: '上海虹桥', depart: '06:08', arrive: '12:04', durationMin: 356, price: 498, seat: { name: '二等座', text: '2', available: true } },
      { code: 'D709', fromStation: '北京南', toStation: '上海虹桥', depart: '19:46', arrive: '07:45', durationMin: 719, price: 296, seat: { name: '二等座', text: '有', available: true } },
      { code: '1461', fromStation: '北京', toStation: '上海', depart: '11:59', arrive: '06:45', durationMin: 1126, price: 156.5, seat: { name: '硬座', text: '有', available: true } },
    ],
    leg1: [
      { code: 'G49', fromStation: '北京南', toStation: '南京南', depart: '19:04', arrive: '22:18', durationMin: 194, price: 445, seat: { name: '二等座', text: '有', available: true } },
      { code: 'G33', fromStation: '北京南', toStation: '南京南', depart: '19:00', arrive: '22:14', durationMin: 194, price: 445, seat: { name: '二等座', text: '有', available: true } },
    ],
    leg2: [
      { code: 'G35', fromStation: '南京南', toStation: '上海虹桥', depart: '22:51', arrive: '23:51', durationMin: 60, price: 146, seat: { name: '二等座', text: '有', available: true } },
      { code: 'G459', fromStation: '南京南', toStation: '上海虹桥', depart: '18:51', arrive: '19:54', durationMin: 63, price: 146, seat: { name: '二等座', text: '有', available: true } },
    ],
  };

  function loadDemo() {
    state.rows = [];
    for (const [group, list] of Object.entries(DEMO)) {
      for (const item of list) state.rows.push(makeRow(item, group));
    }
    el.hubInput.value = '南京';
    renderTable();
    setOcrStatus('已载入示例数据：5 趟直达 + 2×2 组合的中转车次。点「计算最优方案」查看结果。');
  }

  /* ------------------------------------------------------------------ *
   * 事件
   * ------------------------------------------------------------------ */
  function readFileAsImage(file) {
    return file;
  }

  function bind() {
    // 表格编辑：直接写回 state，不重渲染（避免输入时丢焦点）
    el.rowsBody.addEventListener('input', (e) => {
      const input = e.target;
      const tr = input.closest('tr');
      if (!tr) return;
      const row = state.rows.find((r) => r.id === tr.dataset.id);
      if (!row) return;
      const field = input.dataset.field;
      if (!field) return;
      row[field] = input.value;
    });

    el.rowsBody.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-field="group"]');
      if (!sel) return;
      const tr = sel.closest('tr');
      const row = state.rows.find((r) => r.id === tr.dataset.id);
      if (row) row.group = sel.value;
      updateCounts();
    });

    el.rowsBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      state.rows = state.rows.filter((r) => r.id !== btn.dataset.del);
      renderTable();
    });

    // 批量分组
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
      renderTable();
      el.results.hidden = true;
      el.recommend.hidden = true;
      setStatus('');
      setOcrStatus('');
    });

    el.demoBtn.addEventListener('click', loadDemo);

    // 截图：点击 / 拖拽 / 选择文件
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

    // 全局粘贴图片
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

    // 文本解析
    el.parseTextBtn.addEventListener('click', () => {
      const text = el.pasteArea.value;
      if (!text.trim()) {
        setOcrStatus('文本框是空的，先粘贴几行车次信息。', 'error');
        return;
      }
      const parsed = window.KunleParse.fromText(text);
      if (!parsed.length) {
        setOcrStatus('没解析出车次。每行至少需要包含车次号，例如：G1 北京南 上海虹桥 06:30 11:24 ¥598', 'error');
        return;
      }
      const n = addParsed(parsed, 'direct');
      setOcrStatus(`文本解析完成：新增 ${n} 趟车次。`);
      el.pasteArea.value = '';
    });

    // 权重
    el.weight.addEventListener('input', () => {
      state.weight = Number(el.weight.value);
      el.weightOut.textContent = `${state.weight}% 省钱`;
      if (state.options.length) {
        window.KunleAlgo.score(state.options, state.weight);
        renderRecommend();
        renderList();
      }
    });

    el.computeBtn.addEventListener('click', compute);

    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      [...el.tabs.children].forEach((b) => b.classList.toggle('is-active', b === btn));
      state.sort = btn.dataset.sort;
      if (state.options.length) renderList();
    });

    el.onlyBuyable.addEventListener('change', () => {
      state.onlyBuyable = el.onlyBuyable.checked;
      if (state.options.length) renderList();
    });
    el.onlyDirect.addEventListener('change', () => {
      state.onlyDirect = el.onlyDirect.checked;
      if (state.options.length) renderList();
    });
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

  function boot() {
    bind();
    el.weightOut.textContent = `${state.weight}% 省钱`;
    updateCounts();
    checkEngine();
    el.buildInfo.textContent = document.lastModified
      ? `页面更新：${new Date(document.lastModified).toLocaleString('zh-CN')}`
      : '';

    if (new URLSearchParams(location.search).get('demo') === '1') {
      loadDemo();
      setTimeout(compute, 80);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
