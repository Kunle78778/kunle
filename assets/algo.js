/**
 * algo.js —— 购票方案的计算核心（纯函数，不碰网络）
 *
 * 三个能力：
 *   1. buildOptions：把表格行转成统一方案（直达 / 两程中转）
 *   2. score：按「省钱↔省时」权重归一化打分，并标记 Pareto 前沿
 *   3. recommend：给出最划算、最省时、综合最优三个结论
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KunleAlgo = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  function durationBetween(depart, arrive) {
    const d = toMinutes(depart);
    let a = toMinutes(arrive);
    if (d == null || a == null) return null;
    if (a < d) a += 1440;
    return a - d;
  }

  function rowToOption(row) {
    if (!row || !row.code) return null;
    const durationMin =
      Number(row.durationMin) > 0 ? Number(row.durationMin) : durationBetween(row.depart, row.arrive);
    if (durationMin == null || durationMin <= 0) return null;

    const price = row.price == null || row.price === '' ? null : Number(row.price);
    return {
      kind: 'direct',
      key: 'd-' + row.code + '-' + (row.depart || ''),
      code: row.code,
      depart: row.depart || '',
      arrive: row.arrive || '',
      durationMin,
      price: Number.isFinite(price) && price > 0 ? price : null,
      fromStation: row.fromStation || '',
      toStation: row.toStation || '',
      seatText: row.seatText || '',
      buyable: row.seatAvailable !== false,
      legs: [
        {
          code: row.code,
          from: row.fromStation || '',
          to: row.toStation || '',
          depart: row.depart || '',
          arrive: row.arrive || '',
          price: Number.isFinite(price) && price > 0 ? price : null,
        },
      ],
    };
  }

  /**
   * @param {object[]} directRows 直达行
   * @param {object[]} leg1Rows   第一程行（A → 中转站）
   * @param {object[]} leg2Rows   第二程行（中转站 → B）
   * @param {{hub?:string, minTransfer?:number, maxWait?:number}} opts
   */
  function buildOptions(directRows, leg1Rows, leg2Rows, opts) {
    const o = opts || {};
    const minTransfer = Number(o.minTransfer) > 0 ? Number(o.minTransfer) : 30;
    const maxWait = Number(o.maxWait) > 0 ? Number(o.maxWait) : 480;
    const hub = (o.hub || '').trim();

    const options = [];
    const warnings = [];

    for (const r of directRows || []) {
      const opt = rowToOption(r);
      if (opt) options.push(opt);
    }

    const leg1 = (leg1Rows || []).map(rowToOption).filter(Boolean);
    const leg2 = (leg2Rows || []).map(rowToOption).filter(Boolean);

    if (leg1.length && !leg2.length) warnings.push('已填第一程，但缺少第二程车次，未生成中转方案。');
    if (leg2.length && !leg1.length) warnings.push('已填第二程，但缺少第一程车次，未生成中转方案。');

    let skippedWait = 0;
    for (const a of leg1) {
      for (const b of leg2) {
        const aArr = toMinutes(a.arrive);
        let bDep = toMinutes(b.depart);
        if (aArr == null || bDep == null) continue;

        let gap = bDep - aArr;
        if (gap < 0) gap += 1440; // 跨夜
        if (gap < minTransfer || gap > maxWait) {
          skippedWait++;
          continue;
        }

        const totalMinutes = a.durationMin + gap + b.durationMin;
        const price = a.price != null && b.price != null ? a.price + b.price : null;

        options.push({
          kind: 'transfer',
          key: 't-' + a.code + '-' + b.code,
          code: a.code + ' + ' + b.code,
          depart: a.depart,
          arrive: b.arrive,
          durationMin: totalMinutes,
          price,
          fromStation: a.fromStation,
          toStation: b.toStation,
          hub: hub || a.toStation || b.fromStation || '中转站',
          waitMin: gap,
          buyable: a.buyable && b.buyable,
          legs: [
            { code: a.code, from: a.fromStation, to: a.toStation, depart: a.depart, arrive: a.arrive, price: a.price },
            { code: b.code, from: b.fromStation, to: b.toStation, depart: b.depart, arrive: b.arrive, price: b.price },
          ],
        });
      }
    }

    if (skippedWait > 0) {
      warnings.push(`有 ${skippedWait} 个中转组合因换乘时间不在 ${minTransfer}~${maxWait} 分钟内被排除。`);
    }

    return { options, warnings };
  }

  /**
   * 归一化打分 + Pareto 前沿
   * @param {object[]} options
   * @param {number} weightPercent 0=纯省时，100=纯省钱
   */
  function score(options, weightPercent) {
    const priced = options.filter((o) => o.price != null);
    const priceVals = priced.map((o) => o.price);
    const timeVals = options.map((o) => o.durationMin);

    const minP = Math.min(...priceVals);
    const maxP = Math.max(...priceVals);
    const minT = Math.min(...timeVals);
    const maxT = Math.max(...timeVals);

    const norm = (v, lo, hi) => (hi === lo ? 0.5 : (v - lo) / (hi - lo));
    const w = Math.min(100, Math.max(0, Number(weightPercent) || 0)) / 100;

    for (const o of options) {
      if (o.price == null) {
        // 没有票价：不参与省钱比较，给一个偏大的分数
        o.score = 0.8 + w * 0.2;
        o.pareto = false;
        o.priceUnknown = true;
        continue;
      }
      o.priceUnknown = false;
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

  function recommend(options, weightPercent) {
    const usable = options.filter((o) => o.price != null && o.durationMin != null);
    if (!usable.length) return [];

    const byPrice = [...usable].sort((a, b) => a.price - b.price)[0];
    const byTime = [...usable].sort((a, b) => a.durationMin - b.durationMin)[0];
    const byScore = [...usable].sort((a, b) => a.score - b.score)[0];

    const list = [
      { card: 'is-cheap', tag: '最划算 · 花钱最少', data: byPrice, note: '所有方案里总价最低的买法' },
      { card: 'is-fast', tag: '最省时 · 到得最早', data: byTime, note: '含换乘等待后总耗时最短' },
      {
        card: 'is-best',
        tag: '综合最优 · ' + (Number(weightPercent) || 0) + '% 省钱',
        data: byScore,
        note: '按你设定的省钱/省时权重加权',
      },
    ];

    const seen = new Set();
    return list.filter((x) => {
      if (!x.data || seen.has(x.data.key)) return false;
      seen.add(x.data.key);
      return true;
    });
  }

  return { buildOptions, score, recommend, rowToOption, durationBetween, toMinutes };
});
