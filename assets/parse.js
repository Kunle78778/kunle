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
    let m = /^(\d{1,2}):(\d{2})$/.exec(token);
    if (!m) {
      // OCR 常把冒号吞掉：07 45 / 0745 都按时间处理（时 0-23、分 0-59 才算）
      m = /^(\d{1,2})(\d{2})$/.exec(token);
      if (!m) return null;
    }
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

    row.depart = times[0] || null;
    row.arrive = times[1] || null;
    row.fromStation = places[0] || '';
    row.toStation = places[1] || '';

    // 没有历时就用发到时刻推算（含跨夜）
    if (row.durationMin == null && row.depart && row.arrive) {
      row.durationMin = durationBetween(row.depart, row.arrive);
    }

    // OCR 漏识车次号时，如果这一行还有时间/票价，说明只是「车次那一格没认出来」，
    // 保留该行并在表格里留空，让用户补全 —— 静默丢弃才是真正的问题。
    if (!row.code) {
      const hasEnough =
        (row.depart || row.arrive) && (row.price != null || row.durationMin != null);
      if (!hasEnough) return null;
      row.code = '';
      row.missingCode = true;
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
   * 兜底解析：不依赖「同一行」这个假设
   *
   * 手机 App 的车次卡片常常是竖排的：
   *     G1
   *     06:30  北京南
   *     11:24  上海虹桥
   *     4时54分
   *     ¥598
   * 这时按 y 聚类会切出一堆残缺行。此方法改为「按车次号切段」：
   * 从每个车次号开始，把它之后的所有片段都喂给 extractRow，直到遇到下一个车次号。
   *
   * @param {{text:string,x:number,y:number}[]} lines
   */
  function fromOcrStream(lines) {
    const items = (lines || [])
      .map((l) => ({
        text: normalize(l.text),
        x: Number(l.x) || 0,
        y: Number(l.y) || 0,
      }))
      .filter((l) => l.text);

    if (!items.length) return [];

    items.sort((a, b) => a.y - b.y || a.x - b.x);

    const groups = [];
    let current = null;

    for (const it of items) {
      const isTime = /^\d{1,2}:\d{2}$/.test(it.text);
      const code = isTime ? null : fixTrainCode(it.text);
      if (code) {
        current = { tokens: [it.text], y: it.y };
        groups.push(current);
      } else if (current) {
        current.tokens.push(it.text);
      }
    }

    const rows = [];
    for (const g of groups) {
      const row = extractRow(g.tokens);
      if (row) {
        row.y = Math.round(g.y);
        rows.push(row);
      }
    }
    return rows;
  }

  /** 给解析结果打分，用来在两种解析策略里挑更靠谱的那份 */
  function scoreRows(rows) {
    return (rows || []).reduce(
      (s, r) =>
        s +
        (r.code ? 2 : 0) +
        (r.price != null ? 2 : 0) +
        (r.depart ? 1 : 0) +
        (r.arrive ? 1 : 0) +
        (r.durationMin != null ? 1 : 0),
      0
    );
  }

  /**
   * OCR 结果（带包围盒）→ 车次行
   *
   * 两条策略同时跑，取更靠谱的那份：
   *   1) 按 y 聚类成行（横排表格截图）
   *   2) 按车次号切段（手机 App 竖排卡片截图）
   *
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

    const clustered = [];
    for (const g of groups) {
      g.items.sort((a, b) => a.x - b.x);
      const row = extractRow(g.items.map((i) => i.text));
      if (row) {
        row.y = Math.round(g.y); // 保留纵向位置，供「车次补识」按行对齐
        clustered.push(row);
      }
    }

    for (const r of clustered) {
      if (r.code) r.missingCode = false;
    }

    const streamed = fromOcrStream(items);

    if (!clustered.length) return streamed;
    if (!streamed.length) return clustered;
    return scoreRows(streamed) > scoreRows(clustered) ? streamed : clustered;
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

  /* ------------------------------------------------------------------ *
   * CSV 导入 / 导出
   * ------------------------------------------------------------------ */

  const CSV_HEADER = ['车次', '出发站', '到达站', '发车', '到达', '历时(分)', '票价', '余票', '分组'];

  /** CSV 字段转义：含逗号、引号、换行时用双引号包裹 */
  function csvEscape(value) {
    const s = String(value == null ? '' : value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * 行数据 → CSV 文本
   * @param {object[]} rows
   */
  function toCSV(rows) {
    const lines = [CSV_HEADER.join(',')];
    for (const r of rows || []) {
      lines.push(
        [
          r.code || '',
          r.fromStation || '',
          r.toStation || '',
          r.depart || '',
          r.arrive || '',
          r.durationMin == null ? '' : r.durationMin,
          r.price == null ? '' : r.price,
          r.seatText || '',
          r.group || 'direct',
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    return lines.join('\r\n') + '\r\n';
  }

  /** 极简 CSV 行解析：支持引号包裹与转义双引号 */
  function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  /** 表头 → 字段名映射（兼容中英文表头） */
  const HEADER_ALIASES = {
    code: ['车次', '车次号', 'train', 'code', 'trainno'],
    fromStation: ['出发站', '出发', '始发站', 'from', 'fromstation'],
    toStation: ['到达站', '到达', '终到站', 'to', 'tostation'],
    depart: ['发车', '发车时间', '出发时间', 'depart', 'start'],
    arrive: ['到达时间', 'arrive', 'end'],
    durationMin: ['历时(分)', '历时', '耗时', 'duration', 'minutes'],
    price: ['票价', '价格', 'price', 'fare'],
    seatText: ['余票', '席别', '座位', 'seat', 'tickets'],
    group: ['分组', 'group', 'type'],
  };

  function mapHeader(cell) {
    const key = String(cell || '').trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some((a) => a.toLowerCase() === key)) return field;
    }
    return null;
  }

  /**
   * CSV 文本 → 行数据
   * 有表头时按表头映射；没有表头时退化为「按字段顺序猜测」
   * @param {string} text
   * @param {string} group 默认分组
   */
  function fromCSV(text, group) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '');
    if (!lines.length) return [];

    const firstCells = splitCsvLine(lines[0]);
    const mapped = firstCells.map(mapHeader);
    const hasHeader = mapped.filter(Boolean).length >= 3;

    const rows = [];
    const body = hasHeader ? lines.slice(1) : lines;

    for (const line of body) {
      const cells = splitCsvLine(line);
      if (hasHeader) {
        const row = {
          code: '',
          fromStation: '',
          toStation: '',
          depart: '',
          arrive: '',
          durationMin: null,
          price: null,
          seatText: '',
          group: group || 'direct',
        };
        cells.forEach((cell, i) => {
          const field = mapped[i];
          if (!field) return;
          if (field === 'durationMin') row.durationMin = Number(cell) || null;
          else if (field === 'price') row.price = cell === '' ? null : Number(cell);
          else row[field] = cell.trim();
        });
        if (row.code) rows.push(row);
      } else {
        const parsed = extractRow(cells);
        if (parsed) {
          parsed.group = group || 'direct';
          rows.push(parsed);
        }
      }
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
    fromOcrStream,
    scoreRows,
    fromText,
    blankRow,
    durationBetween,
    toMinutes,
    parseTime,
    parsePrice,
    // CSV
    CSV_HEADER,
    csvEscape,
    toCSV,
    splitCsvLine,
    fromCSV,
  };
});
