/**
 * algo.js —— 购票方案的计算核心（纯函数，不碰网络、不碰 DOM）
 *
 * 能力：
 *   1. buildChains     最多三段的行程链组合（直达 / 一次中转 / 两次中转）
 *   2. applyFilters    条件筛选（席别、时段、跨夜、价格上限、耗时上限）
 *   3. score           归一化加权打分 + Pareto 支配判定
 *   4. recommend       最划算 / 最省时 / 综合最优
 *   5. stats           统计信息与「相对最便宜直达」的省钱幅度
 *
 * 所有函数都可在 Node 里单独测试（见 tests/）。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KunleAlgo = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MINUTE_OF_DAY = 1440;

  /* ------------------------------------------------------------------ *
   * 基础时间工具
   * ------------------------------------------------------------------ */

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
    if (a < d) a += MINUTE_OF_DAY;
    return a - d;
  }

  function formatMinutes(min) {
    if (min == null || !Number.isFinite(min)) return '—';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h > 0 ? `${h}小时${String(m).padStart(2, '0')}分` : `${m}分`;
  }

  /** 把「发车分钟 + 历时」换算成到达时刻与跨天数 */
  function arrivalInfo(departMin, durationMin) {
    if (departMin == null || durationMin == null) {
      return { time: '', dayOffset: 0, minuteOfDay: null };
    }
    const total = departMin + durationMin;
    const dayOffset = Math.floor(total / MINUTE_OF_DAY);
    const mod = total % MINUTE_OF_DAY;
    const hh = String(Math.floor(mod / 60)).padStart(2, '0');
    const mm = String(mod % 60).padStart(2, '0');
    return { time: `${hh}:${mm}`, dayOffset, minuteOfDay: mod };
  }

  /* ------------------------------------------------------------------ *
   * 行 → 行程段
   * ------------------------------------------------------------------ */

  /**
   * 把表格的一行转成"单段行程"
   * @param {object} row 表格行
   * @returns {object|null} 缺少车次号或算不出历时则返回 null
   */
  function rowToLeg(row) {
    if (!row || !row.code) return null;

    const departMin = toMinutes(row.depart);
    let durationMin = Number(row.durationMin) > 0 ? Number(row.durationMin) : null;

    if (durationMin == null && row.depart && row.arrive) {
      durationMin = durationBetween(row.depart, row.arrive);
    }
    if (durationMin == null || durationMin <= 0) return null;

    const arriveMin = departMin == null ? null : departMin + durationMin;
    const priceNum = row.price === '' || row.price == null ? NaN : Number(row.price);
    const price = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null;

    return {
      code: row.code,
      from: row.fromStation || '',
      to: row.toStation || '',
      depart: row.depart || '',
      arrive: row.arrive || arrivalInfo(departMin, durationMin).time,
      departMin,
      arriveMin,
      durationMin,
      price,
      seatText: row.seatText || '',
      buyable: row.seatAvailable !== false,
      overnight: arriveMin != null ? arriveMin >= MINUTE_OF_DAY : false,
    };
  }

  /** 单段行程 → 直达方案 */
  function legToOption(leg, index) {
    return {
      kind: 'direct',
      key: 'd-' + leg.code + '-' + leg.depart + '-' + index,
      code: leg.code,
      depart: leg.depart,
      arrive: leg.arrive,
      departMin: leg.departMin,
      durationMin: leg.durationMin,
      price: leg.price,
      fromStation: leg.from,
      toStation: leg.to,
      seatText: leg.seatText,
      buyable: leg.buyable,
      overnight: leg.overnight,
      legs: [{ ...leg }],
      transferCount: 0,
      waitMin: 0,
      waits: [],
      hubs: [],
      hub: '',
    };
  }

  /**
   * 把多段行程拼成一个中转方案
   * @param {object[]} legs 已按顺序排列的行程段
   * @param {number[]} waits 相邻两段之间的等待分钟
   * @param {string[]} hubNames 各换乘站名称
   */
  function chainToOption(legs, waits, hubNames) {
    const totalMinutes =
      legs.reduce((sum, l) => sum + l.durationMin, 0) + waits.reduce((a, b) => a + b, 0);
    const prices = legs.map((l) => l.price);
    const price = prices.every((p) => p != null) ? prices.reduce((a, b) => a + b, 0) : null;
    const first = legs[0];
    const last = legs[legs.length - 1];

    return {
      kind: legs.length === 2 ? 'transfer' : 'double-transfer',
      key: 'c-' + legs.map((l) => l.code).join('-'),
      code: legs.map((l) => l.code).join(' + '),
      depart: first.depart,
      arrive: last.arrive,
      departMin: first.departMin,
      durationMin: totalMinutes,
      price,
      fromStation: first.from,
      toStation: last.to,
      seatText: '',
      buyable: legs.every((l) => l.buyable),
      overnight: (first.departMin || 0) + totalMinutes >= MINUTE_OF_DAY,
      legs: legs.map((l) => ({ ...l })),
      transferCount: legs.length - 1,
      waitMin: waits.reduce((a, b) => a + b, 0),
      waits: [...waits],
      hubs: [...(hubNames || [])],
      hub: hubNames && hubNames.length ? hubNames.join(' → ') : '',
    };
  }

  /* ------------------------------------------------------------------ *
   * 行程链组合
   * ------------------------------------------------------------------ */

  const DEFAULTS = {
    minTransfer: 30,
    maxWait: 480,
    maxLegs: 3,
    /** 每个层级保留的组合数上限，避免组合爆炸 */
    keepPerLevel: 120,
    /** 最终方案数量上限 */
    maxOptions: 800,
  };

  function chainDuration(chain) {
    return chain.legs.reduce((s, l) => s + l.durationMin, 0) + chain.waits.reduce((x, y) => x + y, 0);
  }

  /**
   * 生成方案
   *
   * 分组语义：
   *   legGroups[0] —— 直达（只生成单段方案，不参与拼接）
   *   legGroups[1] —— 第一程，legGroups[2] 第二程，legGroups[3] 第三程
   *   拼接从「第一程」开始，依次串到第二程、第三程，最多 maxLegs 段。
   *
   * @param {object[][]} legGroups
   * @param {object} opts { minTransfer, maxWait, maxLegs, keepPerLevel, maxOptions }
   * @returns {{options:object[], warnings:string[]}}
   */
  function buildChains(legGroups, opts) {
    const o = { ...DEFAULTS, ...(opts || {}) };
    const groups = (legGroups || []).map((rows) => (rows || []).map(rowToLeg).filter(Boolean));

    const warnings = [];
    const options = [];

    // 直达
    (groups[0] || []).forEach((leg, i) => options.push(legToOption(leg, i)));

    // 行程链：从第一程开始
    const maxChainLegs = Math.min(o.maxLegs, groups.length - 1);
    if (maxChainLegs < 2) {
      if (options.length === 0) warnings.push('没有可用的车次数据。');
      return { options, warnings };
    }

    let frontier = (groups[1] || []).map((leg) => ({ legs: [leg], waits: [] }));
    if (!frontier.length) {
      warnings.push('第一程没有可用车次，无法生成中转方案。');
      return { options, warnings };
    }

    for (let level = 2; level <= maxChainLegs; level++) {
      const nextGroup = groups[level] || [];
      if (!nextGroup.length) break;

      const candidates = [];
      for (const chain of frontier) {
        const prev = chain.legs[chain.legs.length - 1];
        for (const next of nextGroup) {
          if (prev.arriveMin == null || next.departMin == null) continue;

          let wait = next.departMin - prev.arriveMin;
          if (wait < 0) wait += MINUTE_OF_DAY; // 跨夜
          if (wait < o.minTransfer || wait > o.maxWait) continue;

          candidates.push({ legs: [...chain.legs, next], waits: [...chain.waits, wait] });
        }
      }

      if (!candidates.length) {
        warnings.push(`第 ${level} 程与上一程之间没有满足换乘时间要求的组合。`);
        break;
      }

      candidates.sort((a, b) => chainDuration(a) - chainDuration(b));

      if (candidates.length > o.keepPerLevel) {
        warnings.push(
          `第 ${level} 程组合数 ${candidates.length} 过多，已按总耗时保留前 ${o.keepPerLevel} 个。`
        );
      }
      frontier = candidates.slice(0, o.keepPerLevel);

      for (const c of frontier) {
        options.push(chainToOption(c.legs, c.waits, c.legs.slice(0, -1).map((l) => l.to)));
      }
    }

    if (options.length === 0) warnings.push('没有可用的车次数据。');

    if (options.length > o.maxOptions) {
      options.sort((a, b) => a.durationMin - b.durationMin);
      return { options: options.slice(0, o.maxOptions), warnings };
    }
    return { options, warnings };
  }

  /** 兼容旧接口：直达 + 第一程 + 第二程 */
  function buildOptions(directRows, leg1Rows, leg2Rows, opts) {
    return buildChains([directRows || [], leg1Rows || [], leg2Rows || []], opts);
  }

  /* ------------------------------------------------------------------ *
   * 筛选
   * ------------------------------------------------------------------ */

  const EMPTY_FILTERS = {
    onlyBuyable: false,
    onlyDirect: false,
    seatKeyword: '',
    departFrom: '',
    departTo: '',
    maxPrice: null,
    maxDuration: null,
    excludeOvernight: false,
    maxTransfers: null,
  };

  function applyFilters(options, filters) {
    const f = { ...EMPTY_FILTERS, ...(filters || {}) };
    const fromMin = toMinutes(f.departFrom);
    const toMin = toMinutes(f.departTo);
    const seatKey = String(f.seatKeyword || '').trim();
    const maxPrice = f.maxPrice == null || f.maxPrice === '' ? null : Number(f.maxPrice);
    const maxDuration =
      f.maxDuration == null || f.maxDuration === '' ? null : Number(f.maxDuration);

    return (options || []).filter((o) => {
      if (f.onlyBuyable && !o.buyable) return false;
      if (f.onlyDirect && o.transferCount !== 0) return false;
      if (f.maxTransfers !== null && f.maxTransfers !== '' && o.transferCount > Number(f.maxTransfers)) {
        return false;
      }
      if (f.excludeOvernight && o.overnight) return false;

      if (seatKey) {
        const hay =
          (o.seatText || '') + ' ' + (o.legs || []).map((l) => l.seatText || '').join(' ');
        if (!hay.includes(seatKey)) return false;
      }

      if (fromMin != null || toMin != null) {
        if (o.departMin == null) return false;
        if (fromMin != null && o.departMin < fromMin) return false;
        if (toMin != null && o.departMin > toMin) return false;
      }

      if (maxPrice != null && Number.isFinite(maxPrice)) {
        if (o.price == null || o.price > maxPrice) return false;
      }
      if (maxDuration != null && Number.isFinite(maxDuration)) {
        if (o.durationMin > maxDuration) return false;
      }
      return true;
    });
  }

  /* ------------------------------------------------------------------ *
   * 评分与 Pareto
   * ------------------------------------------------------------------ */

  /** o 是否不被任何其他（有票价的）方案支配 */
  function isPareto(priced, o) {
    return !priced.some(
      (x) =>
        x !== o &&
        x.price <= o.price &&
        x.durationMin <= o.durationMin &&
        (x.price < o.price || x.durationMin < o.durationMin)
    );
  }

  function score(options, weightPercent) {
    const list = options || [];
    if (!list.length) return list;

    const priced = list.filter((o) => o.price != null);
    const priceVals = priced.map((o) => o.price);
    const timeVals = list.map((o) => o.durationMin).filter((v) => Number.isFinite(v));

    const minP = priceVals.length ? Math.min(...priceVals) : 0;
    const maxP = priceVals.length ? Math.max(...priceVals) : 0;
    const minT = timeVals.length ? Math.min(...timeVals) : 0;
    const maxT = timeVals.length ? Math.max(...timeVals) : 0;

    const norm = (v, lo, hi) => (hi === lo ? 0.5 : (v - lo) / (hi - lo));
    const w = Math.min(100, Math.max(0, Number(weightPercent) || 0)) / 100;

    for (const o of list) {
      if (o.price == null) {
        o.score = 0.8 + w * 0.2;
        o.pareto = false;
        o.priceUnknown = true;
        continue;
      }
      o.priceUnknown = false;
      const pn = norm(o.price, minP, maxP);
      const tn = norm(o.durationMin, minT, maxT);
      o.score = w * pn + (1 - w) * tn;
      o.pareto = isPareto(priced, o);
    }
    return list;
  }

  function paretoFront(options) {
    const priced = (options || []).filter((o) => o.price != null && Number.isFinite(o.durationMin));
    return priced.filter((o) => isPareto(priced, o)).sort((a, b) => a.price - b.price);
  }

  /* ------------------------------------------------------------------ *
   * 推荐与统计
   * ------------------------------------------------------------------ */

  function recommend(options, weightPercent) {
    const usable = (options || []).filter((o) => o.price != null && Number.isFinite(o.durationMin));
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

  /**
   * 统计：方案规模、价格区间、与「最便宜直达」相比能省多少
   */
  function stats(options) {
    const list = options || [];
    const priced = list.filter((o) => o.price != null);
    const direct = list.filter((o) => o.transferCount === 0);
    const directPriced = direct.filter((o) => o.price != null);

    const minPrice = priced.length ? Math.min(...priced.map((o) => o.price)) : null;
    const maxPrice = priced.length ? Math.max(...priced.map((o) => o.price)) : null;
    const minDuration = list.length ? Math.min(...list.map((o) => o.durationMin)) : null;
    const maxDuration = list.length ? Math.max(...list.map((o) => o.durationMin)) : null;
    const baseDirect = directPriced.length ? Math.min(...directPriced.map((o) => o.price)) : null;

    return {
      count: list.length,
      directCount: direct.length,
      transferCount: list.filter((o) => o.transferCount === 1).length,
      doubleTransferCount: list.filter((o) => o.transferCount >= 2).length,
      pricedCount: priced.length,
      unknownPriceCount: list.length - priced.length,
      minPrice,
      maxPrice,
      avgPrice: priced.length ? priced.reduce((s, o) => s + o.price, 0) / priced.length : null,
      minDuration,
      maxDuration,
      paretoCount: paretoFront(list).length,
      cheapestDirect: baseDirect,
      savedVsCheapestDirect: baseDirect != null && minPrice != null ? baseDirect - minPrice : null,
    };
  }

  return {
    MINUTE_OF_DAY,
    DEFAULTS,
    EMPTY_FILTERS,
    toMinutes,
    durationBetween,
    formatMinutes,
    arrivalInfo,
    rowToLeg,
    legToOption,
    chainToOption,
    buildChains,
    buildOptions,
    applyFilters,
    score,
    isPareto,
    paretoFront,
    recommend,
    stats,
  };
});
