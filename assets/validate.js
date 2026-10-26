/**
 * validate.js —— 数据校验（纯函数）
 *
 * 用户的数据来自手动录入 / OCR / CSV，一定会有错。
 * 这一层负责在计算前把问题挑出来，而不是让错误静默影响结果。
 *
 * 分级：
 *   error —— 会导致该行无法参与计算
 *   warn  —— 能算，但结果可能不可信
 *   info  —— 提示性信息
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KunleValidate = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TRAIN_RE = /^[GDCKZTSYL]?\d{1,4}$/;
  const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

  const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };

  function toMinutes(hhmm) {
    const m = TIME_RE.exec(String(hhmm || '').trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function issue(level, rowId, field, message) {
    return { level, rowId: rowId || '', field: field || '', message };
  }

  /**
   * 校验单行
   * @param {object} row
   * @param {object} ctx { group }
   * @returns {object[]} issues
   */
  function validateRow(row, ctx) {
    const out = [];
    const group = (ctx && ctx.group) || row.group || 'direct';
    const id = row.id || '';

    // 完全空行不报错（用户可能刚点了「添加一行」）
    const empty =
      !String(row.code || '').trim() &&
      !String(row.depart || '').trim() &&
      !String(row.arrive || '').trim() &&
      (row.price === '' || row.price == null);
    if (empty) return out;

    // 车次
    const code = String(row.code || '').trim();
    if (!code) out.push(issue('error', id, 'code', '缺少车次号'));
    else if (!TRAIN_RE.test(code)) {
      out.push(issue('warn', id, 'code', `车次「${code}」格式不常见，请确认`));
    }

    // 时间
    const dMin = toMinutes(row.depart);
    const aMin = toMinutes(row.arrive);
    if (!String(row.depart || '').trim()) {
      out.push(issue('error', id, 'depart', '缺少发车时间'));
    } else if (dMin == null) {
      out.push(issue('error', id, 'depart', `发车时间「${row.depart}」格式应为 HH:MM`));
    }
    if (!String(row.arrive || '').trim()) {
      out.push(issue('warn', id, 'arrive', '缺少到达时间，将按历时推算'));
    } else if (aMin == null) {
      out.push(issue('error', id, 'arrive', `到达时间「${row.arrive}」格式应为 HH:MM`));
    }

    // 历时
    const dur = Number(row.durationMin);
    if (row.durationMin === '' || row.durationMin == null) {
      if (dMin == null || aMin == null) {
        out.push(issue('error', id, 'durationMin', '缺少历时，且无法由发到时刻推算'));
      }
    } else if (!Number.isFinite(dur) || dur <= 0) {
      out.push(issue('error', id, 'durationMin', '历时必须大于 0'));
    } else if (dMin != null && aMin != null) {
      let calc = aMin - dMin;
      if (calc < 0) calc += 1440;
      if (Math.abs(calc - dur) > 5) {
        out.push(
          issue(
            'warn',
            id,
            'durationMin',
            `历时 ${dur} 分钟与发到时刻推算的 ${calc} 分钟不一致`
          )
        );
      }
    }

    // 票价
    if (row.price === '' || row.price == null) {
      out.push(issue('warn', id, 'price', '未填票价，该方案不参与比价'));
    } else {
      const p = Number(row.price);
      if (!Number.isFinite(p) || p <= 0) out.push(issue('error', id, 'price', '票价必须是正数'));
      else if (p > 5000) out.push(issue('warn', id, 'price', `票价 ¥${p} 异常偏高，请确认`));
    }

    // 站点
    const from = String(row.fromStation || '').trim();
    const to = String(row.toStation || '').trim();
    if (!from) out.push(issue('warn', id, 'fromStation', '缺少出发站'));
    if (!to) out.push(issue('warn', id, 'toStation', '缺少到达站'));
    if (from && to && from === to) {
      out.push(issue('error', id, 'toStation', '出发站与到达站相同'));
    }

    // 跨夜提醒
    if (dMin != null && aMin != null && aMin < dMin) {
      out.push(issue('info', id, 'arrive', '到达时间早于发车时间，按次日到达处理'));
    }

    // 分组
    if (!['direct', 'leg1', 'leg2', 'leg3'].includes(group)) {
      out.push(issue('warn', id, 'group', `未知分组「${group}」`));
    }

    return out;
  }

  /**
   * 校验全部行，另外做跨行检查（重复车次、换乘站衔接）
   */
  function validateRows(rows, opts) {
    const o = opts || {};
    const list = rows || [];
    const issues = [];

    for (const row of list) issues.push(...validateRow(row));

    // 同一分组内重复车次
    const seen = new Map();
    for (const row of list) {
      const code = String(row.code || '').trim();
      if (!code) continue;
      const key = row.group + '::' + code;
      if (seen.has(key)) {
        issues.push(issue('warn', row.id, 'code', `分组内重复车次「${code}」，可能重复录入`));
      } else {
        seen.set(key, row.id);
      }
    }

    // 换乘站衔接：第一程到达站 vs 第二程出发站
    const leg1 = list.filter((r) => r.group === 'leg1');
    const leg2 = list.filter((r) => r.group === 'leg2');
    const hub = String(o.hub || '').trim();

    if (leg1.length && leg2.length) {
      const arriveStations = new Set(leg1.map((r) => String(r.toStation || '').trim()).filter(Boolean));
      const departStations = new Set(leg2.map((r) => String(r.fromStation || '').trim()).filter(Boolean));
      const matched = [...arriveStations].some((s) => departStations.has(s));

      if (!matched && arriveStations.size && departStations.size) {
        issues.push(
          issue(
            'warn',
            '',
            'toStation',
            `第一程到达站（${[...arriveStations].join('、')}）与第二程出发站（${[
              ...departStations,
            ].join('、')}）没有交集，可能不是同一个中转站`
          )
        );
      }

      if (hub) {
        const allStations = [...arriveStations, ...departStations];
        const hit = allStations.some((s) => s.includes(hub) || hub.includes(s));
        if (allStations.length && !hit) {
          issues.push(
            issue('info', '', 'hub', `你填的中转站「${hub}」与车次里的站点名称不完全一致，仅作展示用`)
          );
        }
      }
    }

    // 三段时检查第二程与第三程
    const leg3 = list.filter((r) => r.group === 'leg3');
    if (leg2.length && leg3.length) {
      const arrive2 = new Set(leg2.map((r) => String(r.toStation || '').trim()).filter(Boolean));
      const depart3 = new Set(leg3.map((r) => String(r.fromStation || '').trim()).filter(Boolean));
      if (arrive2.size && depart3.size && ![...arrive2].some((s) => depart3.has(s))) {
        issues.push(
          issue('warn', '', 'toStation', '第二程到达站与第三程出发站不衔接，请确认中转站')
        );
      }
    }

    // 直达组为空
    if (!list.some((r) => r.group === 'direct')) {
      issues.push(issue('info', '', 'direct', '没有直达车次，结果只包含中转方案'));
    }

    issues.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

    return {
      issues,
      summary: summarize(issues),
      hasBlocking: issues.some((i) => i.level === 'error'),
    };
  }

  function summarize(issues) {
    const s = { error: 0, warn: 0, info: 0, total: (issues || []).length };
    for (const i of issues || []) s[i.level] = (s[i.level] || 0) + 1;
    return s;
  }

  /** 转成「行 id → 问题列表」，供界面给单元格标红 */
  function byRow(issues) {
    const map = {};
    for (const i of issues || []) {
      if (!i.rowId) continue;
      if (!map[i.rowId]) map[i.rowId] = [];
      map[i.rowId].push(i);
    }
    return map;
  }

  return {
    TRAIN_RE,
    TIME_RE,
    validateRow,
    validateRows,
    summarize,
    byRow,
    toMinutes,
  };
});
