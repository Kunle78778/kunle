/**
 * chart.js —— 价格 / 耗时散点图（Canvas 手绘，无第三方库）
 *
 * 看它能一眼看出三件事：
 *   1. 哪些方案在左下角（又便宜又快）
 *   2. Pareto 前沿长什么样（连起来的折线）
 *   3. 你勾选的方案在整体里处于什么位置
 *
 * 交互：鼠标悬停显示明细，点击回调选中方案。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KunleChart = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KIND_COLOR = {
    direct: '#2563eb',
    transfer: '#7c3aed',
    'double-transfer': '#0d9488',
  };

  const PAD = { top: 22, right: 22, bottom: 44, left: 56 };

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */
  function niceStep(range, targetTicks) {
    if (range <= 0) return 1;
    const rough = range / Math.max(1, targetTicks);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }

  function fmtMinutes(min) {
    if (min == null) return '—';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
  }

  /** 读取 CSS 变量，兼容深浅色 */
  function themeColors(canvas) {
    const cs = getComputedStyle(canvas);
    const get = (name, fallback) => {
      const v = cs.getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    };
    return {
      text: get('--text', '#161a23'),
      muted: get('--muted', '#8b93a1'),
      border: get('--border', '#e3e8f0'),
      card: get('--card', '#ffffff'),
      ok: get('--ok', '#047857'),
      grid: get('--chart-grid', 'rgba(127,127,127,.15)'),
    };
  }

  /* ------------------------------------------------------------------ *
   * 绘图主体
   * ------------------------------------------------------------------ */
  function createChart(canvas, opts) {
    const options = opts || {};
    let data = [];
    let weight = 55;
    let selectedKeys = new Set();
    let hovered = null;
    let geom = null; // 保存点位，供命中检测
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.hidden = true;
    canvas.parentElement.appendChild(tooltip);

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(320, rect.width);
      const h = Math.max(240, rect.height || 320);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx, w, h };
    }

    function computeScales(w, h) {
      const priced = data.filter((o) => o.price != null && Number.isFinite(o.durationMin));
      if (!priced.length) return null;

      const prices = priced.map((o) => o.price);
      const times = priced.map((o) => o.durationMin);

      let minP = Math.min(...prices);
      let maxP = Math.max(...prices);
      let minT = Math.min(...times);
      let maxT = Math.max(...times);

      if (maxP === minP) {
        minP = Math.max(0, minP - 50);
        maxP = maxP + 50;
      }
      if (maxT === minT) {
        minT = Math.max(0, minT - 30);
        maxT = maxT + 30;
      }

      const padP = (maxP - minP) * 0.08;
      const padT = (maxT - minT) * 0.08;

      const innerW = w - PAD.left - PAD.right;
      const innerH = h - PAD.top - PAD.bottom;

      const x = (t) => PAD.left + ((t - (minT - padT)) / (maxT + padT - (minT - padT))) * innerW;
      const y = (p) => PAD.top + innerH - ((p - (minP - padP)) / (maxP + padP - (minP - padP))) * innerH;

      return { x, y, minP: minP - padP, maxP: maxP + padP, minT: minT - padT, maxT: maxT + padT, innerW, innerH };
    }

    function drawAxes(ctx, w, h, s, colors) {
      ctx.save();
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = colors.muted;
      ctx.font = '11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

      // Y 轴（价格）
      const priceStep = niceStep(s.maxP - s.minP, 5);
      const startP = Math.ceil(s.minP / priceStep) * priceStep;
      for (let p = startP; p <= s.maxP; p += priceStep) {
        const yy = s.y(p);
        ctx.beginPath();
        ctx.moveTo(PAD.left, yy);
        ctx.lineTo(w - PAD.right, yy);
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('¥' + Math.round(p), PAD.left - 8, yy);
      }

      // X 轴（耗时）
      const timeStep = niceStep(s.maxT - s.minT, 6);
      const startT = Math.ceil(s.minT / timeStep) * timeStep;
      for (let t = startT; t <= s.maxT; t += timeStep) {
        const xx = s.x(t);
        ctx.beginPath();
        ctx.moveTo(xx, PAD.top);
        ctx.lineTo(xx, h - PAD.bottom);
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(fmtMinutes(t), xx, h - PAD.bottom + 8);
      }

      // 轴标题
      ctx.fillStyle = colors.muted;
      ctx.textAlign = 'center';
      ctx.fillText('总耗时 →', PAD.left + s.innerW / 2, h - 12);

      ctx.save();
      ctx.translate(14, PAD.top + s.innerH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('总价 →', 0, 0);
      ctx.restore();
      ctx.restore();
    }

    function drawPareto(ctx, s, colors) {
      const front = data
        .filter((o) => o.pareto && o.price != null)
        .sort((a, b) => a.durationMin - b.durationMin);
      if (front.length < 2) return;

      ctx.save();
      ctx.strokeStyle = colors.ok;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      front.forEach((o, i) => {
        const px = s.x(o.durationMin);
        const py = s.y(o.price);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.restore();
    }

    function drawPoints(ctx, s, colors) {
      const points = [];
      for (const o of data) {
        if (o.price == null || !Number.isFinite(o.durationMin)) continue;
        const px = s.x(o.durationMin);
        const py = s.y(o.price);
        const isSel = selectedKeys.has(o.key);
        const r = isSel ? 7 : 5;

        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = KIND_COLOR[o.kind] || KIND_COLOR.direct;
        ctx.globalAlpha = isSel ? 1 : 0.78;
        ctx.fill();
        ctx.globalAlpha = 1;

        if (o.pareto) {
          ctx.beginPath();
          ctx.arc(px, py, r + 3.5, 0, Math.PI * 2);
          ctx.strokeStyle = colors.ok;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        if (isSel) {
          ctx.beginPath();
          ctx.arc(px, py, r + 6, 0, Math.PI * 2);
          ctx.strokeStyle = colors.text;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        points.push({ x: px, y: py, r: r + 4, option: o });
      }
      return points;
    }

    function drawLegend(ctx, w, colors) {
      const items = [
        { label: '直达', color: KIND_COLOR.direct },
        { label: '一次中转', color: KIND_COLOR.transfer },
        { label: '两次中转', color: KIND_COLOR['double-transfer'] },
      ];
      ctx.save();
      ctx.font = '11.5px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textBaseline = 'middle';
      let x = PAD.left;
      for (const it of items) {
        ctx.beginPath();
        ctx.arc(x + 5, 12, 5, 0, Math.PI * 2);
        ctx.fillStyle = it.color;
        ctx.fill();
        ctx.fillStyle = colors.muted;
        ctx.textAlign = 'left';
        ctx.fillText(it.label, x + 15, 12);
        x += ctx.measureText(it.label).width + 34;
      }
      ctx.restore();
    }

    function render() {
      const { ctx, w, h } = resize();
      const colors = themeColors(canvas);
      ctx.clearRect(0, 0, w, h);

      const s = computeScales(w, h);
      if (!s) {
        ctx.fillStyle = colors.muted;
        ctx.font = '13px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('需要至少一个填写了票价的方案才能绘图', w / 2, h / 2);
        geom = null;
        return;
      }

      drawAxes(ctx, w, h, s, colors);
      drawPareto(ctx, s, colors);
      const points = drawPoints(ctx, s, colors);
      drawLegend(ctx, w, colors);
      geom = { points, scale: s, w, h };
    }

    /* ---------------- 交互 ---------------- */
    function findPoint(evt) {
      if (!geom) return null;
      const rect = canvas.getBoundingClientRect();
      const mx = evt.clientX - rect.left;
      const my = evt.clientY - rect.top;
      let best = null;
      let bestD = Infinity;
      for (const p of geom.points) {
        const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
        if (d < p.r * p.r && d < bestD) {
          best = p;
          bestD = d;
        }
      }
      return best;
    }

    function showTooltip(point, evt) {
      const o = point.option;
      const rect = canvas.getBoundingClientRect();
      tooltip.innerHTML =
        `<b>${o.code}</b><br>` +
        `${o.price == null ? '未填票价' : '¥' + o.price} · ${fmtMinutes(o.durationMin)}<br>` +
        `${o.fromStation || '?'} → ${o.toStation || '?'}` +
        (o.transferCount ? `<br>中转 ${o.transferCount} 次${o.hub ? ' · ' + o.hub : ''}` : '');
      tooltip.hidden = false;
      tooltip.style.left = Math.min(rect.width - 170, Math.max(6, evt.clientX - rect.left + 12)) + 'px';
      tooltip.style.top = Math.max(6, evt.clientY - rect.top - 10) + 'px';
    }

    function handleMove(evt) {
      const p = findPoint(evt);
      if (p) {
        hovered = p.option;
        canvas.style.cursor = 'pointer';
        showTooltip(p, evt);
      } else {
        hovered = null;
        canvas.style.cursor = 'default';
        tooltip.hidden = true;
      }
    }

    function handleLeave() {
      hovered = null;
      tooltip.hidden = true;
    }

    function handleClick(evt) {
      const p = findPoint(evt);
      if (p && typeof options.onSelect === 'function') options.onSelect(p.option);
    }

    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseleave', handleLeave);
    canvas.addEventListener('click', handleClick);

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(render) : null;
    if (ro) ro.observe(canvas);

    return {
      setData(list) {
        data = list || [];
        render();
      },
      setWeight(w) {
        weight = w;
        render();
      },
      setSelected(keys) {
        selectedKeys = new Set(keys || []);
        render();
      },
      render,
      getHovered() {
        return hovered;
      },
      destroy() {
        canvas.removeEventListener('mousemove', handleMove);
        canvas.removeEventListener('mouseleave', handleLeave);
        canvas.removeEventListener('click', handleClick);
        if (ro) ro.disconnect();
        tooltip.remove();
      },
    };
  }

  return { createChart, KIND_COLOR, fmtMinutes, niceStep };
});
