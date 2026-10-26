/**
 * timeline.js —— 行程时间轴可视化
 *
 * 把一个方案画成一条时间轴：每一段乘车、每一次换乘等待都按真实时长占比排布，
 * 让人一眼看出「时间花在哪」。
 *
 * 纯函数部分（segments / layout）可单独测试，渲染部分输出 SVG 字符串。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KunleTimeline = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RIDE_COLORS = ['#2563eb', '#7c3aed', '#0d9488', '#c2410c'];

  /**
   * 把方案拆成时间轴片段
   * @param {object} option
   * @returns {{type:'ride'|'wait', minutes:number, label:string, code?:string, from?:string, to?:string, depart?:string, arrive?:string, color?:string}[]}
   */
  function segments(option) {
    if (!option || !Array.isArray(option.legs)) return [];
    const out = [];

    option.legs.forEach((leg, i) => {
      out.push({
        type: 'ride',
        minutes: Number(leg.durationMin) || 0,
        label: `${leg.code} ${leg.from} → ${leg.to}`,
        code: leg.code,
        from: leg.from,
        to: leg.to,
        depart: leg.depart,
        arrive: leg.arrive,
        price: leg.price,
        color: RIDE_COLORS[i % RIDE_COLORS.length],
      });

      const wait = Array.isArray(option.waits) ? option.waits[i] : undefined;
      if (wait != null && i < option.legs.length - 1) {
        out.push({
          type: 'wait',
          minutes: Number(wait) || 0,
          label: `换乘等待 ${formatMinutes(wait)}`,
          color: '#b45309',
        });
      }
    });

    return out;
  }

  function formatMinutes(min) {
    if (min == null || !Number.isFinite(Number(min))) return '—';
    const m = Number(min);
    const h = Math.floor(m / 60);
    const rest = Math.round(m % 60);
    return h > 0 ? `${h}小时${String(rest).padStart(2, '0')}分` : `${rest}分`;
  }

  /**
   * 计算每段在给定宽度下的像素位置
   * @param {object[]} segs segments()
   * @param {number} width 可用宽度（含 gap 之前的总宽）
   * @param {object} opts { gap, minWidth }
   */
  function layout(segs, width, opts) {
    const o = { gap: 6, minWidth: 24, ...(opts || {}) };
    const list = (segs || []).filter((s) => s.minutes > 0);
    if (!list.length) return { items: [], total: 0 };

    const total = list.reduce((s, x) => s + x.minutes, 0);
    const gaps = o.gap * Math.max(0, list.length - 1);
    const usable = Math.max(40, width - gaps);

    // 先按比例分配，再保证每段不小于 minWidth
    let items = list.map((s) => ({
      segment: s,
      width: Math.max(o.minWidth, (s.minutes / total) * usable),
    }));

    // 超宽时按比例压缩
    const sum = items.reduce((s, x) => s + x.width, 0);
    if (sum > usable) {
      const k = usable / sum;
      items = items.map((x) => ({ ...x, width: Math.max(o.minWidth, x.width * k) }));
    }

    let x = 0;
    for (const item of items) {
      item.x = x;
      x += item.width + o.gap;
    }

    return { items, total, usedWidth: x - o.gap };
  }

  function escapeXml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    })[c]);
  }

  /**
   * 生成 SVG 字符串
   * @param {object} option
   * @param {object} opts { width, height }
   */
  function toSvg(option, opts) {
    const o = { width: 720, height: 96, ...(opts || {}) };
    const segs = segments(option);
    if (!segs.length) return '';

    const { items } = layout(segs, o.width);
    const barY = 30;
    const barH = 26;
    const height = o.height;

    const rects = items
      .map(({ segment, x, width }) => {
        const isWait = segment.type === 'wait';
        const fill = isWait ? 'var(--warn-bg, #fef3e2)' : segment.color;
        const stroke = isWait ? '#b45309' : segment.color;
        const textColor = isWait ? '#b45309' : '#ffffff';
        const label = isWait ? '等待' : segment.code;
        const labelText =
          width > 54 ? escapeXml(label) : '';

        const title = isWait
          ? escapeXml(segment.label)
          : escapeXml(
              `${segment.code} ${segment.from} ${segment.depart} → ${segment.to} ${segment.arrive}（${formatMinutes(
                segment.minutes
              )}）`
            );

        return `<g>
          <title>${title}</title>
          <rect x="${x.toFixed(1)}" y="${barY}" width="${width.toFixed(1)}" height="${barH}"
                rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1"
                ${isWait ? 'stroke-dasharray="4 3"' : ''} />
          <text x="${(x + width / 2).toFixed(1)}" y="${barY + barH / 2 + 4}" text-anchor="middle"
                font-size="11.5" font-weight="600" fill="${textColor}">${labelText}</text>
          <text x="${x.toFixed(1)}" y="${height - 22}" font-size="10.5" fill="currentColor" opacity="0.75">
            ${escapeXml(segment.type === 'ride' ? segment.depart || '' : formatMinutes(segment.minutes))}
          </text>
          <text x="${x.toFixed(1)}" y="${height - 8}" font-size="10.5" fill="currentColor" opacity="0.55">
            ${escapeXml(segment.type === 'ride' ? segment.from || '' : '换乘')}
          </text>
        </g>`;
      })
      .join('');

    const arriveLabel = option.arrive
      ? `<text x="${o.width - 2}" y="${height - 22}" text-anchor="end" font-size="10.5"
              fill="currentColor" opacity="0.75">${escapeXml(option.arrive)}</text>
         <text x="${o.width - 2}" y="${height - 8}" text-anchor="end" font-size="10.5"
              fill="currentColor" opacity="0.55">${escapeXml(option.toStation || '')}</text>`
      : '';

    return `<svg class="timeline-svg" viewBox="0 0 ${o.width} ${height}" width="100%"
                 height="${height}" role="img"
                 aria-label="${escapeXml(
                   `${option.code} 行程时间轴，共 ${formatMinutes(option.durationMin)}`
                 )}">
      ${rects}
      ${arriveLabel}
    </svg>`;
  }

  /**
   * 渲染到容器
   */
  function render(container, option, opts) {
    if (!container) return;
    const segs = segments(option);
    if (!segs.length) {
      container.innerHTML = '<p class="muted small">该方案没有可展示的分段信息。</p>';
      return;
    }
    const width = Math.max(320, container.clientWidth || 720) - 4;
    container.innerHTML = toSvg(option, { ...(opts || {}), width });

    // 图例
    const legend = segs
      .map(
        (s, i) =>
          `<span class="tl-legend-item">
            <i style="background:${s.type === 'wait' ? 'transparent' : s.color};${
              s.type === 'wait' ? 'border:1px dashed #b45309' : ''
            }"></i>
            ${escapeXml(s.type === 'wait' ? '换乘等待' : s.code)} · ${formatMinutes(s.minutes)}
          </span>`
      )
      .join('');
    container.insertAdjacentHTML(
      'beforeend',
      `<div class="tl-legend">${legend}<span class="tl-legend-item tl-total">合计 ${formatMinutes(
        option.durationMin
      )}</span></div>`
    );
  }

  return { segments, layout, toSvg, render, formatMinutes, RIDE_COLORS };
});
