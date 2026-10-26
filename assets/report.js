/**
 * report.js —— 方案报告：自动洞察 + Markdown / HTML 导出
 *
 * 纯函数，输入方案数组与上下文，输出可读的结论与文档字符串。
 * 用于「导出报告」按钮与打印方案单。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KunleReport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const fmtDur = (min) => {
    if (min == null || !Number.isFinite(min)) return '—';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}小时${String(m).padStart(2, '0')}分` : `${m}分`;
  };

  const money = (v) => (v == null ? '—' : '¥' + Math.round(v * 10) / 10);

  function routeText(o) {
    if (!o) return '';
    if (!o.transferCount) return `${o.fromStation || '?'} → ${o.toStation || '?'}`;
    const stops = [
      o.legs[0].from,
      ...o.legs.slice(0, -1).map((l) => l.to),
      o.legs[o.legs.length - 1].to,
    ];
    return stops.filter(Boolean).join(' → ');
  }

  /* ------------------------------------------------------------------ *
   * 自动洞察
   * ------------------------------------------------------------------ */

  /**
   * 生成文字结论，帮用户理解「到底值不值」
   * @param {object[]} options
   * @returns {{level:string,text:string}[]}
   */
  function insights(options) {
    const list = (options || []).filter((o) => o.price != null && Number.isFinite(o.durationMin));
    const out = [];
    if (!list.length) return out;

    const cheapest = [...list].sort((a, b) => a.price - b.price)[0];
    const fastest = [...list].sort((a, b) => a.durationMin - b.durationMin)[0];
    const directList = list.filter((o) => o.transferCount === 0);

    // 1. 与最便宜直达比较
    if (directList.length) {
      const cheapestDirect = [...directList].sort((a, b) => a.price - b.price)[0];
      const diff = cheapestDirect.price - cheapest.price;
      const timeDiff = cheapest.durationMin - cheapestDirect.durationMin;

      if (diff > 0.5) {
        out.push({
          level: 'good',
          text:
            `最便宜方案比最便宜直达少花 ${money(diff)}` +
            (Math.abs(timeDiff) >= 1
              ? `，但多花 ${fmtDur(Math.abs(timeDiff))}`.replace('多花', timeDiff > 0 ? '多花' : '少花')
              : '，耗时基本持平'),
        });
      } else if (diff < -0.5) {
        out.push({
          level: 'info',
          text: `直达反而更便宜 ${money(-diff)}（直达 ${money(cheapestDirect.price)} vs 最优 ${money(
            cheapest.price
          )}）`,
        });
      } else {
        out.push({ level: 'info', text: '最便宜的中转方案与最便宜直达价格基本持平' });
      }
    } else {
      out.push({ level: 'info', text: '没有直达车次，以下结论均基于中转方案' });
    }

    // 2. 有没有既便宜又更快的中转
    if (directList.length) {
      const cheapestDirect = [...directList].sort((a, b) => a.price - b.price)[0];
      const dominators = list.filter(
        (o) =>
          o.transferCount > 0 &&
          o.price <= cheapestDirect.price &&
          o.durationMin < cheapestDirect.durationMin
      );
      if (dominators.length) {
        const best = [...dominators].sort((a, b) => a.price - b.price)[0];
        out.push({
          level: 'good',
          text: `发现 ${dominators.length} 个中转方案「又便宜又更快」，例如 ${best.code}：${money(
            best.price
          )} / ${fmtDur(best.durationMin)}，优于最便宜直达 ${directList.length ? '' : ''}`,
        });
      }
    }

    // 3. 最省时方案是否贵很多
    const priceGap = fastest.price - cheapest.price;
    if (priceGap > 0.5) {
      const hourSaved = (cheapest.durationMin - fastest.durationMin) / 60;
      if (hourSaved > 0.1) {
        out.push({
          level: 'info',
          text: `最省时的 ${fastest.code} 比最便宜方案多花 ${money(priceGap)}，换来节省 ${hourSaved.toFixed(
            1
          )} 小时（约 ${money(priceGap / hourSaved)} / 小时）`,
        });
      }
    }

    // 4. Pareto 规模
    const front = list.filter((o) => o.pareto);
    out.push({
      level: 'info',
      text: `共 ${list.length} 个可比价方案，其中 ${front.length} 个位于性价比前沿（没有被任何方案在「更便宜」和「更快」上同时压制）`,
    });

    // 5. 跨夜提醒
    const overnight = list.filter((o) => o.overnight);
    if (overnight.length) {
      out.push({
        level: 'warn',
        text: `有 ${overnight.length} 个方案跨夜到达，注意落地后的接驳与住宿安排`,
      });
    }

    // 6. 中转次数分布
    const t1 = list.filter((o) => o.transferCount === 1).length;
    const t2 = list.filter((o) => o.transferCount >= 2).length;
    if (t1 || t2) {
      out.push({
        level: 'info',
        text: `方案构成：直达 ${directList.length} 个、一次中转 ${t1} 个、两次中转 ${t2} 个；中转方案需分段购票，注意第二程余票`,
      });
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * Markdown 报告
   * ------------------------------------------------------------------ */

  function buildMeta(ctx) {
    const c = ctx || {};
    return {
      generatedAt: c.generatedAt || new Date().toISOString(),
      weight: c.weight == null ? 55 : c.weight,
      minTransfer: c.minTransfer == null ? 30 : c.minTransfer,
      maxWait: c.maxWait == null ? 480 : c.maxWait,
      maxLegs: c.maxLegs == null ? 2 : c.maxLegs,
      hub: c.hub || '',
      topN: c.topN == null ? 15 : c.topN,
    };
  }

  function recommendationBlock(options, ctx) {
    const meta = buildMeta(ctx);
    const usable = (options || []).filter((o) => o.price != null);
    if (!usable.length) return [];

    const cheapest = [...usable].sort((a, b) => a.price - b.price)[0];
    const fastest = [...usable].sort((a, b) => a.durationMin - b.durationMin)[0];
    const best = [...usable].sort((a, b) => a.score - b.score)[0];

    return [
      ['最划算', cheapest],
      ['最省时', fastest],
      [`综合最优（${meta.weight}% 省钱）`, best],
    ];
  }

  /**
   * 生成 Markdown 报告
   */
  function markdown(options, ctx) {
    const meta = buildMeta(ctx);
    const list = options || [];
    const priced = list.filter((o) => o.price != null);
    const lines = [];

    lines.push('# 车票最优方案报告');
    lines.push('');
    lines.push(`- 生成时间：${new Date(meta.generatedAt).toLocaleString('zh-CN')}`);
    lines.push(
      `- 参数：权重 ${meta.weight}% 省钱 · 最少换乘 ${meta.minTransfer} 分钟 · 最长等待 ${meta.maxWait} 分钟 · 最多 ${meta.maxLegs} 段`
    );
    if (meta.hub) lines.push(`- 中转站：${meta.hub}`);
    lines.push(
      `- 规模：${list.length} 个方案（有票价 ${priced.length} 个），价格区间 ${
        priced.length ? money(Math.min(...priced.map((o) => o.price))) + ' ~ ' + money(Math.max(...priced.map((o) => o.price))) : '—'
      }`
    );
    lines.push('');

    /* 推荐 */
    lines.push('## 推荐结论');
    lines.push('');
    for (const [label, opt] of recommendationBlock(list, ctx)) {
      lines.push(`### ${label}：${opt.code}（${money(opt.price)}，${fmtDur(opt.durationMin)}）`);
      lines.push('');
      lines.push(`- 路线：${routeText(opt)}`);
      lines.push(`- 时刻：${opt.depart} → ${opt.arrive}`);
      lines.push(`- 中转：${opt.transferCount === 0 ? '直达' : opt.transferCount + ' 次'}`);
      if (opt.transferCount) {
        lines.push(`- 换乘等待：${fmtDur(opt.waitMin)}`);
        opt.legs.forEach((l, i) => {
          lines.push(`  ${i + 1}. ${l.code} ${l.from} ${l.depart} → ${l.to} ${l.arrive} ${money(l.price)}`);
        });
      }
      lines.push('');
    }

    /* 洞察 */
    const ins = insights(list);
    if (ins.length) {
      lines.push('## 结论与提醒');
      lines.push('');
      for (const i of ins) {
        const mark = i.level === 'good' ? '✅' : i.level === 'warn' ? '⚠️' : 'ℹ️';
        lines.push(`- ${mark} ${i.text}`);
      }
      lines.push('');
    }

    /* 方案表 */
    lines.push(`## 方案明细（前 ${Math.min(meta.topN, list.length)} 个）`);
    lines.push('');
    lines.push('| # | 车次 | 路线 | 时刻 | 耗时 | 中转 | 票价 | 前沿 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    list.slice(0, meta.topN).forEach((o, i) => {
      lines.push(
        `| ${i + 1} | ${o.code} | ${routeText(o)} | ${o.depart} → ${o.arrive} | ${fmtDur(
          o.durationMin
        )} | ${o.transferCount === 0 ? '直达' : o.transferCount + ' 次'} | ${money(o.price)} | ${
          o.pareto ? '★' : ''
        } |`
      );
    });
    lines.push('');
    lines.push('> 票价与余票请以 12306 官方页面为准；中转方案需分段购票。');

    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * HTML 报告（打印 / 另存）
   * ------------------------------------------------------------------ */

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function html(options, ctx) {
    const meta = buildMeta(ctx);
    const list = options || [];
    const recs = recommendationBlock(list, ctx);
    const ins = insights(list);

    const recHtml = recs
      .map(
        ([label, o]) => `<div class="rec">
          <h3>${escapeHtml(label)}：${escapeHtml(o.code)}</h3>
          <p><b>${money(o.price)}</b> · ${fmtDur(o.durationMin)} · ${escapeHtml(o.depart)} 发车</p>
          <p>${escapeHtml(routeText(o))} · ${o.transferCount === 0 ? '直达' : o.transferCount + ' 次中转'}</p>
        </div>`
      )
      .join('');

    const insHtml = ins
      .map((i) => `<li class="ins-${i.level}">${escapeHtml(i.text)}</li>`)
      .join('');

    const rowsHtml = list
      .slice(0, meta.topN)
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

    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>车票最优方案报告</title>
<style>
  body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#161a23;line-height:1.65}
  h1{font-size:22px;border-bottom:2px solid #2563eb;padding-bottom:8px}
  h2{font-size:16px;margin-top:26px;color:#1d4ed8}
  h3{font-size:14px;margin:14px 0 4px}
  .meta{color:#666;font-size:12.5px;margin-bottom:16px}
  .rec{border:1px solid #e3e8f0;border-left:4px solid #2563eb;border-radius:8px;padding:10px 14px;margin-bottom:10px;page-break-inside:avoid}
  .rec h3{margin:0 0 4px}
  .rec p{margin:2px 0;font-size:13px}
  ul{font-size:13px;padding-left:20px}
  li{margin:3px 0}
  .ins-good{color:#047857}
  .ins-warn{color:#b45309}
  table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:10px}
  th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left}
  th{background:#eef2f9}
  .foot{color:#888;font-size:11.5px;margin-top:18px}
  @media print{body{margin:0}.rec{border-color:#999}}
</style></head><body>
<h1>车票最优方案报告</h1>
<div class="meta">
  生成时间 ${escapeHtml(new Date(meta.generatedAt).toLocaleString('zh-CN'))} ｜
  权重 ${meta.weight}% 省钱 ｜ 最少换乘 ${meta.minTransfer} 分钟 ｜ 最多 ${meta.maxLegs} 段
  ${meta.hub ? ' ｜ 中转站 ' + escapeHtml(meta.hub) : ''}
</div>
<h2>推荐结论</h2>
${recHtml}
<h2>结论与提醒</h2>
<ul>${insHtml}</ul>
<h2>方案明细（前 ${Math.min(meta.topN, list.length)} 个）</h2>
<table><thead><tr><th>#</th><th>车次</th><th>路线</th><th>时刻</th><th>耗时</th><th>中转</th><th>票价</th><th>前沿</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>
<div class="foot">票价与余票请以 12306 官方页面为准；中转方案需分段购票。本报告由「车票最优助手」在本地生成。</div>
</body></html>`;
  }

  function fileName(ext) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `kunle-方案报告-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
      d.getHours()
    )}${pad(d.getMinutes())}.${ext || 'md'}`;
  }

  return { insights, markdown, html, fileName, routeText, fmtDur, money, buildMeta };
});
