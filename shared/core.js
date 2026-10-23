/**
 * core.js —— 12306 数据获取与解析核心（Node 与 Cloudflare Worker 共用）
 *
 * 设计要点：
 * 1. 只用全局 fetch，不依赖 Node 专有 API，因此同一份代码可在 Node 和 Worker 运行。
 * 2. 12306 的接口没有 CORS 头，浏览器不能直连，必须由服务端/代理转发。
 * 3. 12306 会下发 Cookie 且查询接口路径会变（query / queryZ / queryG ...），
 *    这里做了 Cookie 维护与端点自动切换。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const BASE = 'https://kyfw.12306.cn';

/* ------------------------------------------------------------------ *
 * 缓存（内存，进程内有效）
 * ------------------------------------------------------------------ */
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl = CACHE_TTL) {
  cache.set(key, { value, exp: Date.now() + ttl });
  return value;
}

/* ------------------------------------------------------------------ *
 * Cookie 维护
 * ------------------------------------------------------------------ */
let cookieJar = '';
let cookieAt = 0;

async function refreshCookies() {
  const res = await fetch(`${BASE}/otn/leftTicket/init`, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
  });
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') {
    list = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) list = raw.split(/,(?=[^;]+?=)/);
  }
  cookieJar = list.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  cookieAt = Date.now();
  await res.text().catch(() => '');
  return cookieJar;
}

async function ensureCookies(force = false) {
  if (force || !cookieJar || Date.now() - cookieAt > 10 * 60 * 1000) {
    try {
      await refreshCookies();
    } catch {
      /* 拿不到 Cookie 也继续尝试，部分接口仍可访问 */
    }
  }
}

async function rawGet(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${BASE}/otn/leftTicket/init`,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      ...(cookieJar ? { Cookie: cookieJar } : {}),
    },
    redirect: 'follow',
  });
  const text = await res.text();
  return { status: res.status, text };
}

/**
 * 带 Cookie 与端点切换的 JSON 请求。
 * 12306 有时会返回 {"c_url":"leftTicket/queryG",...} 提示正确端点，这里自动重试一次。
 */
async function apiGet(url, retry = true) {
  await ensureCookies();
  const { status, text } = await rawGet(url);

  if (retry && status !== 200) {
    await ensureCookies(true);
    return apiGet(url, false);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (retry) {
      await ensureCookies(true);
      return apiGet(url, false);
    }
    throw new Error('12306 返回了非 JSON 内容');
  }

  if (json && json.c_url && json.status === false) {
    if (!retry) throw new Error('12306 端点切换失败：' + json.c_url);
    const next = String(json.c_url).replace(/^\/?otn\//, '').replace(/^\/+/, '');
    leftTicketPath = next;
    return apiGet(url.replace(/leftTicket\/[^?]+/, `leftTicket/${next}`), false);
  }

  return json;
}

/* 查询端点会变，默认 queryG，遇到 c_url 提示会自动更新 */
let leftTicketPath = 'queryG';

/* ------------------------------------------------------------------ *
 * 并发限流
 * ------------------------------------------------------------------ */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ *
 * 车站数据
 * ------------------------------------------------------------------ */
const STATION_RE = /@([^|@]*)\|([^|@]*)\|([^|@]*)\|([^|@]*)\|([^|@]*)\|(\d+)\|([^|@]*)\|([^|@]*)/g;

export async function loadStations() {
  const cached = cacheGet('stations');
  if (cached) return cached;

  const { status, text } = await rawGet(
    `${BASE}/otn/resources/js/framework/station_name.js`
  );
  if (status !== 200 || !text.includes('@')) throw new Error('车站数据获取失败');

  const stations = [];
  STATION_RE.lastIndex = 0;
  let m;
  while ((m = STATION_RE.exec(text)) !== null) {
    const [, abbr, name, code, pinyin, short, order, cityCode, cityName] = m;
    stations.push({
      name,
      code,
      pinyin: pinyin || '',
      abbr: abbr || '',
      short: short || '',
      cityCode,
      cityName: cityName || name,
    });
  }

  // 城市表：优先取「名字 == 城市名」的那条（12306 的城市级聚合码，如 北京=BJP）
  const cityMap = new Map();
  for (const s of stations) {
    if (!s.cityName) continue;
    const exist = cityMap.get(s.cityName);
    const isAggregate = s.name === s.cityName;
    if (!exist || isAggregate) {
      cityMap.set(s.cityName, {
        name: s.cityName,
        code: isAggregate ? s.code : (exist ? exist.code : s.code),
        pinyin: s.pinyin,
        abbr: s.abbr,
        stations: exist ? exist.stations : [],
      });
    }
    const c = cityMap.get(s.cityName);
    if (s.name !== s.cityName && !c.stations.some((x) => x.code === s.code)) {
      c.stations.push({ name: s.name, code: s.code });
    }
  }

  const cities = [...cityMap.values()].map((c) => ({
    ...c,
    pinyin: c.pinyin || '',
    abbr: c.abbr || '',
  }));

  const result = { stations, cities };
  return cacheSet('stations', result, 24 * 60 * 60 * 1000);
}

/** 城市搜索：支持中文、全拼、首字母 */
export async function searchCities(keyword, limit = 12) {
  const { cities } = await loadStations();
  const q = String(keyword || '').trim().toLowerCase();
  if (!q) {
    return cities.filter((c) => c.stations.length >= 2).slice(0, limit);
  }
  const scored = [];
  for (const c of cities) {
    let score = 0;
    if (c.name === q) score = 100;
    else if (c.name.startsWith(q)) score = 90;
    else if (c.name.includes(q)) score = 70;
    else if (c.abbr === q) score = 85;
    else if (c.pinyin === q) score = 80;
    else if (c.pinyin.startsWith(q)) score = 60;
    else if (c.abbr.startsWith(q)) score = 55;
    else if (c.pinyin.includes(q)) score = 40;
    if (score > 0) scored.push({ ...c, score });
  }
  scored.sort((a, b) => b.score - a.score || b.stations.length - a.stations.length);
  return scored.slice(0, limit).map(({ score, ...rest }) => rest);
}

/** 城市名 → 城市码（如 北京 → BJP） */
export async function resolveCity(nameOrCode) {
  const { cities } = await loadStations();
  const key = String(nameOrCode || '').trim();
  if (!key) return null;
  const upper = key.toUpperCase();
  return (
    cities.find((c) => c.name === key) ||
    cities.find((c) => c.code === upper) ||
    cities.find((c) => c.abbr === key.toLowerCase()) ||
    cities.find((c) => c.pinyin === key.toLowerCase()) ||
    null
  );
}

/* ------------------------------------------------------------------ *
 * 车次查询与解析
 * ------------------------------------------------------------------ */
const SEAT_NAMES = {
  21: '高级软卧',
  23: '软卧',
  24: '软座',
  25: '特等座',
  26: '无座',
  28: '硬卧',
  29: '硬座',
  30: '二等座',
  31: '一等座',
  32: '商务座',
  33: '动卧',
};

function parseAvailability(v) {
  if (!v) return { available: false, text: '—' };
  if (v === '有') return { available: true, text: '有' };
  if (v === '无' || v === '*') return { available: false, text: '无' };
  const n = Number(v);
  if (Number.isFinite(n)) {
    return { available: n > 0, text: n > 0 ? String(n) : '无' };
  }
  return { available: false, text: v };
}

function toMinutes(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function parseDuration(text) {
  if (!text) return null;
  const m = /^(\d+):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseRow(row, nameMap) {
  if (!row || typeof row !== 'string') return null;
  const f = row.split('|');
  if (f.length < 30 || !f[3]) return null;

  const seats = [];
  for (const [idx, name] of Object.entries(SEAT_NAMES)) {
    const av = parseAvailability(f[Number(idx)]);
    if (av.text === '—') continue;
    seats.push({ name, text: av.text, available: av.available });
  }

  const depart = f[8];
  const arrive = f[9];
  const dm = toMinutes(depart);
  let am = toMinutes(arrive);
  if (dm != null && am != null && am < dm) am += 1440; // 跨夜

  return {
    trainNo: f[2],
    code: f[3],
    fromCode: f[6],
    toCode: f[7],
    fromStation: nameMap[f[6]] || f[6],
    toStation: nameMap[f[7]] || f[7],
    fromNo: f[16],
    toNo: f[17],
    seatTypes: f[35] || '',
    depart,
    arrive,
    departMin: dm,
    arriveMin: am,
    duration: parseDuration(f[10]),
    durationText: f[10],
    canBuy: f[11] === 'Y',
    seats,
    price: null,
    prices: null,
  };
}

export async function queryTrains(fromCode, toCode, date) {
  const key = `lt:${fromCode}:${toCode}:${date}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const url =
    `${BASE}/otn/leftTicket/${leftTicketPath}` +
    `?leftTicketDTO.train_date=${date}` +
    `&leftTicketDTO.from_station=${fromCode}` +
    `&leftTicketDTO.to_station=${toCode}` +
    `&purpose_codes=ADULT`;

  const json = await apiGet(url);
  if (!json || json.status === false || !json.data) {
    return cacheSet(key, { trains: [], nameMap: {} }, 60 * 1000);
  }
  const nameMap = json.data.map || {};
  const trains = (json.data.result || [])
    .map((r) => parseRow(r, nameMap))
    .filter(Boolean);

  return cacheSet(key, { trains, nameMap }, 5 * 60 * 1000);
}

/* ------------------------------------------------------------------ *
 * 票价
 * ------------------------------------------------------------------ */
const PRICE_NAMES = {
  A9: '商务座',
  P: '特等座',
  M: '一等座',
  O: '二等座',
  S: '商务座',
  9: '商务座',
  A6: '高级动卧',
  A4: '动卧',
  F: '动卧',
  6: '高级软卧',
  4: '软卧',
  3: '硬卧',
  2: '软座',
  1: '硬座',
  WZ: '无座',
  YB: '硬卧',
  RW: '软卧',
  YZ: '硬座',
  ZE: '二等座',
  ZY: '一等座',
  SWZ: '商务座',
};

function parsePriceValue(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s.includes('¥')) {
    const n = Number(s.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  // 不带货币符号的值是「角」为单位的放大值，需要除以 10
  return Number.isFinite(n) ? n / 10 : null;
}

export async function queryPrice(train, date) {
  if (!train || !train.trainNo) return null;
  const key = `pr:${train.trainNo}:${train.fromNo}:${train.toNo}:${date}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const url =
    `${BASE}/otn/leftTicket/queryTicketPrice` +
    `?train_no=${train.trainNo}` +
    `&from_station_no=${train.fromNo}` +
    `&to_station_no=${train.toNo}` +
    `&seat_types=${train.seatTypes}` +
    `&train_date=${date}`;

  let json;
  try {
    json = await apiGet(url);
  } catch {
    return null;
  }
  if (!json || !json.data) return cacheSet(key, null, 60 * 1000);

  const byName = new Map();
  for (const [code, val] of Object.entries(json.data)) {
    if (code === 'train_no' || Array.isArray(val)) continue;
    const price = parsePriceValue(val);
    if (price == null || price <= 0) continue;
    const name = PRICE_NAMES[code] || code;
    const prev = byName.get(name);
    if (!prev || price < prev.price) byName.set(name, { name, price, code });
  }

  const list = [...byName.values()].sort((a, b) => a.price - b.price);
  const result =
    list.length === 0
      ? null
      : {
          cheapest: list[0].price,
          seats: list,
          byName: Object.fromEntries(list.map((x) => [x.name, x.price])),
        };
  return cacheSet(key, result, 10 * 60 * 1000);
}

/** 给一批车次补票价，控制并发与总耗时 */
async function attachPrices(trains, date, { limit = 6, deadlineMs = 15000 } = {}) {
  const started = Date.now();
  await mapLimit(trains, limit, async (t) => {
    if (Date.now() - started > deadlineMs) return null;
    const p = await queryPrice(t, date);
    if (p) {
      t.price = p.cheapest;
      t.prices = p.seats;
    }
    return p;
  });
  return trains;
}

/* ------------------------------------------------------------------ *
 * 中转方案
 * ------------------------------------------------------------------ */
const HUB_CANDIDATES = [
  '郑州', '南京', '济南', '徐州', '蚌埠', '合肥', '武汉', '长沙',
  '西安', '石家庄', '天津', '杭州', '南昌', '苏州', '无锡', '沈阳',
  '太原', '洛阳', '商丘', '阜阳', '衡阳', '株洲',
];

const MIN_TRANSFER_MIN = 30;   // 同城换乘最少预留
const MAX_TRANSFER_MIN = 8 * 60; // 等待超过 8 小时不建议

function buildTransfers(fromCity, toCity, hubCity, leg1, leg2) {
  const combos = [];
  const l1 = leg1.filter((t) => t.departMin != null && t.arriveMin != null);
  const l2 = leg2.filter((t) => t.departMin != null && t.arriveMin != null);

  for (const a of l1) {
    for (const b of l2) {
      // 中转站：按到达/出发的车站判断，跨站需更多缓冲
      const sameStation = a.toStation === b.fromStation;
      const gapRaw = b.departMin - a.arriveMin;
      const gap = gapRaw < 0 ? gapRaw + 1440 : gapRaw;
      const need = sameStation ? MIN_TRANSFER_MIN : MIN_TRANSFER_MIN + 30;
      if (gap < need || gap > MAX_TRANSFER_MIN) continue;

      const totalMin = a.duration != null && b.duration != null ? gap + a.duration + b.duration : null;

      combos.push({
        type: 'transfer',
        hub: hubCity.name,
        hubCode: hubCity.code,
        leg1: a,
        leg2: b,
        waitMin: gap,
        sameStation,
        totalMinutes: totalMin,
        totalPrice: null,
      });
    }
  }
  return combos;
}

/* ------------------------------------------------------------------ *
 * 主查询
 * ------------------------------------------------------------------ */
export async function search({ from, to, date, transfer = false, maxHubs = 8 }) {
  const fromCity = await resolveCity(from);
  const toCity = await resolveCity(to);
  if (!fromCity) throw new Error('出发城市无法识别：' + from);
  if (!toCity) throw new Error('到达城市无法识别：' + to);
  if (fromCity.code === toCity.code) throw new Error('出发地与目的地相同');

  const started = Date.now();

  /* --- 直达 --- */
  const directRes = await queryTrains(fromCity.code, toCity.code, date);
  const direct = directRes.trains.map((t) => ({ ...t, type: 'direct' }));

  /* --- 中转候选 --- */
  let transfers = [];
  if (transfer) {
    const { cities } = await loadStations();
    const hubs = HUB_CANDIDATES.map((n) => cities.find((c) => c.name === n))
      .filter(Boolean)
      .filter((c) => c.code !== fromCity.code && c.code !== toCity.code)
      .slice(0, maxHubs);

    const legs = await mapLimit(hubs, 3, async (hub) => {
      try {
        const [a, b] = await Promise.all([
          queryTrains(fromCity.code, hub.code, date),
          queryTrains(hub.code, toCity.code, date),
        ]);
        return buildTransfers(fromCity, toCity, hub, a.trains, b.trains);
      } catch {
        return [];
      }
    });

    transfers = legs.flat().filter(Boolean);
    // 先按总耗时筛出有希望的组合，再补票价（控制请求量）
    transfers.sort((x, y) => (x.totalMinutes ?? 1e9) - (y.totalMinutes ?? 1e9));
    transfers = transfers.slice(0, 18);

    const legTrains = new Map();
    for (const c of transfers) {
      for (const t of [c.leg1, c.leg2]) {
        const k = `${t.trainNo}:${t.fromNo}:${t.toNo}`;
        if (!legTrains.has(k)) legTrains.set(k, t);
      }
    }
    await attachPrices([...legTrains.values()], date, { limit: 6, deadlineMs: 12000 });

    for (const c of transfers) {
      if (c.leg1.price != null && c.leg2.price != null) {
        c.totalPrice = c.leg1.price + c.leg2.price;
      }
    }
    transfers = transfers
      .filter((c) => c.totalPrice != null)
      .sort((x, y) => x.totalPrice - y.totalPrice)
      .slice(0, 12);
  }

  /* --- 直达补票价 --- */
  await attachPrices(direct, date, { limit: 6, deadlineMs: 15000 });

  return {
    from: { name: fromCity.name, code: fromCity.code, stations: fromCity.stations },
    to: { name: toCity.name, code: toCity.code, stations: toCity.stations },
    date,
    direct,
    transfers,
    meta: {
      source: '12306',
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      endpoint: leftTicketPath,
    },
  };
}
