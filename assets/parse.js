/**
 * parse.js —— 把「截图 OCR 文字」或「粘贴的文本」解析成结构化的车次行
 *
 * 设计原则：
 *   - 纯函数，不依赖 DOM，可在 Node 里单元测试
 *   - 容错优先：OCR 会有错字（G1 → GI、598.0 → 598 · 0），解析结果交给用户在表格里核对修改
 *   - 不联网、不抓取，数据完全来自用户提供的截图或文本
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KunleParse = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SEAT_WORDS = [
    '商务座', '特等座', '一等座', '二等座', '高级软卧', '软卧', '硬卧',
    '软座', '硬座', '无座', '动卧', '高级动卧', '包厢', '包座',
  ];

  /** 全角转半角 + 常见 OCR 噪音修正 */
  function normalize(str) {
    let s = String(str == null ? '' : str);
    s = s.replace(/[￥¥]/g, '¥');
    // 全角 ASCII → 半角
    s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    s = s.replace(/\u3000/g, '');
    s = s.replace(/[·•．・]/g, '.');
    s = s.replace(/[—–－]/g, '-');
    s = s.replace(/\s+/g, '');
    return s;
  }

  /** 车次号修正：I/l → 1、O → 0（仅用于字母+数字组合的修正） */
  function fixTrainCode(token) {
    const t = token.toUpperCase().replace(/[Il|]/g, '1').replace(/O/g, '0');
    const m = /^([GDCKZTSYL])(\d{1,4})$/.exec(t);
    if (m) return m[1] + m[2];
    if (/^\d{3,4}$/.test(t)) return t; // 普速纯数字车次，如 1461
    return null;
  }

  function parseTime(token) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(token);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }

  function parseDuration(token) {
    let m = /(\d{1,2})(?:小时|时)(\d{1,2})分?/.exec(token);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    m = /(\d{1,2})h(\d{1,2})m/i.exec(token);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    return null;
  }

  function parsePrice(token) {
    if (!token.includes('¥')) return null;
    const m = /¥\s*(\d+(?:\.\d{1,2})?)/.exec(token);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function parseSeat(token) {
    for (const w of SEAT_WORDS) {
      if (token.includes(w)) {
        const rest = token.slice(token.indexOf(w) + w.length);
        let available = null;
        if (/有/.test(rest)) available = true;
        else if (/无|售完|\*/.test(rest)) available = false;
        else {
          const n = /\d+/.exec(rest);
          if (n) available = Number(n[0]) > 0;
        }
        return { name: w, text: rest || '', available };
      }
    }
    return null;
  }

  function isChinese(token) {
    return /^[\u4e00-\u9fa5]{2,10}$/.test(token);
  }

  const STOP_WORDS = ['预订', '候补', '选择', '查看', '余票', '全部', '筛选', '出发', '到达'];

  /**
   * 从一组 token 中抽取一行车次信息
   * @param {string[]} tokens 同一行的文本片段（按 x 排序）
   */
  function extractRow(tokens) {
    const row = {
      code: null,
      depart: null,
      arrive: null,
      durationMin: null,
      price: null,
      fromStation: '',
      toStation: '',
      seat: null,
      tokens: [],
    };
    const times = [];
    const places = [];

    for (const raw of tokens) {
      const t = normalize(raw);
      if (!t) continue;
      row.tokens.push(t);

      // 车次
      if (!row.code) {
        const code = fixTrainCode(t);
        if (code && !/^\d{1,2}:\d{2}$/.test(t)) {
          row.code = code;
          continue;
        }
      }
      // 时间
      const time = parseTime(t);
      if (time) {
        if (times.length < 2) times.push(time);
        continue;
      }
      // 历时
      if (row.durationMin == null) {
        const dur = parseDuration(t);
        if (dur != null) {
          row.durationMin = dur;
          continue;
        }
      }
      // 价格
      if (row.price == null) {
        const price = parsePrice(t);
        if (price != null) {
          row.price = price;
          continue;
        }
      }
      // 席别/余票
      if (!row.seat) {
        const seat = parseSeat(t);
        if (seat) {
          row.seat = seat;
          continue;
        }
      }
      // 站名
      if (isChinese(t) && !STOP_WORDS.includes(t) && places.length < 2) {
        places.push(t);
      }
    }

    if (!row.code) return null;

    row.depart = times[0] || null;
    row.arrive = times[1] || null;
    row.fromStation = places[0] || '';
    row.toStation = places[1] || '';

    // 没有历时就用发到时刻推算（含跨夜）
    if (row.durationMin == null && row.depart && row.arrive) {
      row.durationMin = durationBetween(row.depart, row.arrive);
    }
    return row;
  }

  function toMinutes(hhmm) {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  }

  function durationBetween(depart, arrive) {
    const d = toMinutes(depart);
    let a = toMinutes(arrive);
    if (d == null || a == null) return null;
    if (a < d) a += 1440;
    return a - d;
  }

  /**
   * OCR 结果（带包围盒）→ 按 y 聚类成行 → 每行按 x 排序 → 解析
   * @param {{text:string,x:number,y:number,w?:number,h?:number}[]} lines
   */
  function fromOcrLines(lines) {
    const items = (lines || [])
      .map((l) => ({ text: String(l.text || ''), x: Number(l.x) || 0, y: Number(l.y) || 0, h: Number(l.h) || 20 }))
      .filter((l) => l.text.trim());

    if (!items.length) return [];

    const avgH = items.reduce((s, l) => s + l.h, 0) / items.length;
    const tol = Math.max(10, avgH * 0.55);

    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const groups = [];
    for (const it of sorted) {
      const g = groups.find((grp) => Math.abs(grp.y - it.y) <= tol);
      if (g) {
        g.items.push(it);
        g.y = (g.y * (g.items.length - 1) + it.y) / g.items.length;
      } else {
        groups.push({ y: it.y, items: [it] });
      }
    }

    const rows = [];
    for (const g of groups) {
      g.items.sort((a, b) => a.x - b.x);
      const row = extractRow(g.items.map((i) => i.text));
      if (row) rows.push(row);
    }
    return rows;
  }

  /**
   * 粘贴的纯文本 → 车次行
   * 支持每行用 逗号 / 制表符 / 空格 / 竖线 分隔，字段顺序随意
   */
  function fromText(text) {
    const rows = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const tokens = line.split(/[,，\t|;；]+|\s{2,}|\s+/).filter(Boolean);
      const row = extractRow(tokens);
      if (row) rows.push(row);
    }
    return rows;
  }

  /** 生成给表格用的初始行 */
  function blankRow() {
    return {
      code: '',
      depart: '',
      arrive: '',
      durationMin: null,
      price: null,
      fromStation: '',
      toStation: '',
      seat: null,
      tokens: [],
    };
  }

  return {
    normalize,
    fixTrainCode,
    extractRow,
    fromOcrLines,
    fromText,
    blankRow,
    durationBetween,
    toMinutes,
    parseTime,
    parsePrice,
  };
});
