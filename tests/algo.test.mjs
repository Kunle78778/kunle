/**
 * algo.test.mjs —— 计算核心的单元测试
 *
 * 运行：npm test   （即 node --test tests/）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import '../assets/algo.js';
const A = globalThis.KunleAlgo;

/* ---------------- 测试数据 ---------------- */

const row = (over = {}) => ({
  code: 'G1',
  fromStation: '北京南',
  toStation: '上海虹桥',
  depart: '06:30',
  arrive: '11:24',
  durationMin: 294,
  price: 598,
  seatText: '二等座 有',
  seatAvailable: true,
  ...over,
});

const directRows = [
  row({ code: 'G1', depart: '06:30', arrive: '11:24', durationMin: 294, price: 598 }),
  row({ code: 'G3', depart: '07:00', arrive: '11:41', durationMin: 281, price: 667 }),
  row({ code: '1461', depart: '11:59', arrive: '06:45', durationMin: 1126, price: 156.5 }),
];

const leg1Rows = [
  row({ code: 'G801', fromStation: '北京南', toStation: '郑州东', depart: '07:00', arrive: '09:30', durationMin: 150, price: 309 }),
  row({ code: 'G803', fromStation: '北京南', toStation: '郑州东', depart: '08:00', arrive: '10:40', durationMin: 160, price: 309 }),
];

const leg2Rows = [
  row({ code: 'G1801', fromStation: '郑州东', toStation: '南京南', depart: '11:10', arrive: '15:00', durationMin: 230, price: 230 }),
];

const leg3Rows = [
  row({ code: 'G35', fromStation: '南京南', toStation: '上海虹桥', depart: '17:00', arrive: '18:00', durationMin: 60, price: 146 }),
];

/* ---------------- 时间工具 ---------------- */

test('toMinutes 解析正常时间', () => {
  assert.equal(A.toMinutes('06:30'), 390);
  assert.equal(A.toMinutes('00:00'), 0);
  assert.equal(A.toMinutes('23:59'), 1439);
});

test('toMinutes 拒绝非法输入', () => {
  assert.equal(A.toMinutes('24:00'), null);
  assert.equal(A.toMinutes('12:60'), null);
  assert.equal(A.toMinutes('abc'), null);
  assert.equal(A.toMinutes(''), null);
});

test('durationBetween 处理跨夜', () => {
  assert.equal(A.durationBetween('06:30', '11:24'), 294);
  assert.equal(A.durationBetween('19:46', '07:45'), 719);
});

test('formatMinutes 输出可读文本', () => {
  assert.equal(A.formatMinutes(294), '4小时54分');
  assert.equal(A.formatMinutes(45), '45分');
  assert.equal(A.formatMinutes(null), '—');
});

test('arrivalInfo 给出到达时刻与跨天数', () => {
  const a = A.arrivalInfo(19 * 60 + 46, 719);
  assert.equal(a.time, '07:45');
  assert.equal(a.dayOffset, 1);
});

/* ---------------- 行 → 行程段 ---------------- */

test('rowToLeg 提取价格与时长', () => {
  const leg = A.rowToLeg(row());
  assert.equal(leg.code, 'G1');
  assert.equal(leg.price, 598);
  assert.equal(leg.durationMin, 294);
  assert.equal(leg.buyable, true);
});

test('rowToLeg 缺少车次返回 null', () => {
  assert.equal(A.rowToLeg(row({ code: '' })), null);
});

test('rowToLeg 用发到时刻推算历时', () => {
  const leg = A.rowToLeg(row({ durationMin: '', depart: '06:30', arrive: '11:24' }));
  assert.equal(leg.durationMin, 294);
});

test('rowToLeg 票价为 0 或空时记为 null', () => {
  assert.equal(A.rowToLeg(row({ price: '' })).price, null);
  assert.equal(A.rowToLeg(row({ price: 0 })).price, null);
});

/* ---------------- 组合 ---------------- */

test('只有直达组时，方案数等于直达车次数', () => {
  const { options } = A.buildChains([directRows]);
  assert.equal(options.length, 3);
  assert.ok(options.every((o) => o.transferCount === 0));
});

test('两组数据生成一次中转方案', () => {
  // 直达组留空，第一程（郑州）到达后接第二程（南京）
  const { options } = A.buildChains([[], leg1Rows, leg2Rows]);
  const transfers = options.filter((o) => o.transferCount === 1);
  assert.equal(transfers.length, 2);
  assert.equal(options.filter((o) => o.transferCount === 0).length, 0);
  assert.equal(transfers[0].kind, 'transfer');
});

test('三组数据生成两次中转方案', () => {
  const { options } = A.buildChains([directRows, leg1Rows, leg2Rows, leg3Rows]);
  const doubles = options.filter((o) => o.transferCount === 2);
  assert.ok(doubles.length > 0, '应至少生成一个两次中转方案');
  const d = doubles[0];
  assert.equal(d.legs.length, 3);
  assert.equal(d.waits.length, 2);

  // 总耗时 = 各段历时 + 等待
  const sum = d.legs.reduce((s, l) => s + l.durationMin, 0) + d.waits.reduce((a, b) => a + b, 0);
  assert.equal(d.durationMin, sum);
});

test('中转总价等于两程之和', () => {
  const { options } = A.buildChains([[], leg1Rows, leg2Rows]);
  const t = options.find((o) => o.transferCount === 1);
  assert.equal(t.price, 309 + 230);
});
test('换乘时间小于下限的组合被排除', () => {
  const arrive = row({ code: 'A1', depart: '06:00', arrive: '08:00', durationMin: 120, price: 100 });
  const depSoon = row({ code: 'B1', depart: '08:10', arrive: '10:00', durationMin: 110, price: 100 });
  const { options } = A.buildChains([[], [arrive], [depSoon]], { minTransfer: 30 });
  assert.equal(options.filter((o) => o.transferCount === 1).length, 0);
});

test('等待超过上限的组合被排除', () => {
  const arrive = row({ code: 'A1', depart: '06:00', arrive: '08:00', durationMin: 120, price: 100 });
  const depLate = row({ code: 'B1', depart: '20:00', arrive: '22:00', durationMin: 120, price: 100 });
  const { options } = A.buildChains([[], [arrive], [depLate]], { minTransfer: 30, maxWait: 300 });
  assert.equal(options.filter((o) => o.transferCount === 1).length, 0);
});

test('跨夜换乘正确计算等待时间', () => {
  const arrive = row({ code: 'A1', depart: '20:00', arrive: '23:50', durationMin: 230, price: 100 });
  const depNext = row({ code: 'B1', depart: '00:20', arrive: '02:00', durationMin: 100, price: 100 });
  const { options } = A.buildChains([[], [arrive], [depNext]], { minTransfer: 30, maxWait: 480 });
  const t = options.find((o) => o.transferCount === 1);
  assert.ok(t, '跨夜 30 分钟换乘应当成立');
  assert.equal(t.waits[0], 30);
});

test('组合数超过上限时按耗时裁剪并给出提示', () => {
  const many1 = Array.from({ length: 30 }, (_, i) =>
    row({ code: 'A' + i, depart: '06:00', arrive: '09:00', durationMin: 180, price: 100 })
  );
  const many2 = Array.from({ length: 30 }, (_, i) =>
    row({ code: 'B' + i, depart: '10:00', arrive: '13:00', durationMin: 180, price: 100 })
  );
  const { options, warnings } = A.buildChains([[], many1, many2], { keepPerLevel: 10 });
  const transfers = options.filter((o) => o.transferCount === 1);
  assert.equal(transfers.length, 10);
  assert.equal(options.length, 10);
  assert.ok(warnings.length > 0);
});

/* ---------------- 筛选 ---------------- */

const filterFixture = () => {
  const { options } = A.buildChains([directRows, leg1Rows, leg2Rows]);
  return A.score(options, 50);
};

test('只看直达', () => {
  const list = A.applyFilters(filterFixture(), { onlyDirect: true });
  assert.equal(list.length, 3);
  assert.ok(list.every((o) => o.transferCount === 0));
});

test('席别关键词筛选', () => {
  const list = A.applyFilters(filterFixture(), { seatKeyword: '二等座' });
  assert.ok(list.length > 0);
  const hasSeat = (o) =>
    (o.seatText || '').includes('二等座') ||
    (o.legs || []).some((l) => (l.seatText || '').includes('二等座'));
  assert.ok(list.every(hasSeat));
});

test('票价上限筛选', () => {
  const list = A.applyFilters(filterFixture(), { maxPrice: 350 });
  assert.ok(list.length > 0);
  assert.ok(list.every((o) => o.price != null && o.price <= 350));
});

test('耗时上限筛选', () => {
  const list = A.applyFilters(filterFixture(), { maxDuration: 400 });
  assert.ok(list.every((o) => o.durationMin <= 400));
});

test('发车时段筛选', () => {
  const list = A.applyFilters(filterFixture(), { departFrom: '06:00', departTo: '07:30' });
  assert.ok(list.length > 0);
  assert.ok(list.every((o) => o.departMin >= 360 && o.departMin <= 450));
});

test('排除跨夜到达', () => {
  const list = A.applyFilters(filterFixture(), { excludeOvernight: true });
  assert.ok(list.every((o) => !o.overnight));
});

test('最多中转次数筛选', () => {
  const list = A.applyFilters(filterFixture(), { maxTransfers: 1 });
  assert.ok(list.every((o) => o.transferCount <= 1));
});

test('组合多个条件', () => {
  const list = A.applyFilters(filterFixture(), { onlyDirect: true, maxPrice: 600 });
  assert.ok(list.every((o) => o.transferCount === 0 && o.price <= 600));
});

/* ---------------- 评分与 Pareto ---------------- */

test('打分：权重 100 时完全按价格排序', () => {
  const list = A.score(
    [
      { key: 'a', code: 'A', price: 100, durationMin: 200 },
      { key: 'b', code: 'B', price: 200, durationMin: 100 },
    ],
    100
  );
  assert.ok(list[0].score < list[1].score);
});

test('打分：权重 0 时完全按耗时排序', () => {
  const list = A.score(
    [
      { key: 'a', code: 'A', price: 100, durationMin: 200 },
      { key: 'b', code: 'B', price: 200, durationMin: 100 },
    ],
    0
  );
  assert.ok(list[1].score < list[0].score);
});

test('Pareto：被支配的方案不算前沿', () => {
  const list = A.score(
    [
      { key: 'a', code: 'A', price: 100, durationMin: 100 },
      { key: 'b', code: 'B', price: 150, durationMin: 120 },
    ],
    50
  );
  const a = list.find((o) => o.key === 'a');
  const b = list.find((o) => o.key === 'b');
  assert.equal(a.pareto, true);
  assert.equal(b.pareto, false);
});

test('Pareto：各有所长时两者都在前沿', () => {
  const list = A.score(
    [
      { key: 'a', code: 'A', price: 100, durationMin: 300 },
      { key: 'b', code: 'B', price: 300, durationMin: 100 },
    ],
    50
  );
  assert.ok(list.every((o) => o.pareto));
});

test('Pareto 前沿按价格升序返回', () => {
  const list = A.score(
    [
      { key: 'a', code: 'A', price: 300, durationMin: 100 },
      { key: 'b', code: 'B', price: 100, durationMin: 300 },
      { key: 'c', code: 'C', price: 200, durationMin: 200 },
    ],
    50
  );
  const front = A.paretoFront(list);
  const prices = front.map((o) => o.price);
  assert.deepEqual(prices, [...prices].sort((x, y) => x - y));
});

test('没有票价的方案不参与 Pareto', () => {
  const list = A.score(
    [
      { key: 'a', code: 'A', price: 100, durationMin: 100 },
      { key: 'b', code: 'B', price: null, durationMin: 50 },
    ],
    50
  );
  const b = list.find((o) => o.key === 'b');
  assert.equal(b.pareto, false);
  assert.equal(b.priceUnknown, true);
});

/* ---------------- 推荐与统计 ---------------- */

test('推荐给出省钱、省时、综合三条结论', () => {
  const list = A.score(
    [
      { key: 'a', code: 'A', price: 100, durationMin: 400 },
      { key: 'b', code: 'B', price: 400, durationMin: 100 },
      { key: 'c', code: 'C', price: 200, durationMin: 200 },
    ],
    50
  );
  const recs = A.recommend(list, 50);
  assert.equal(recs.length, 3);
  assert.equal(recs[0].data.key, 'a');
  assert.equal(recs[1].data.key, 'b');
});

test('推荐会去掉重复方案', () => {
  const list = A.score([{ key: 'a', code: 'A', price: 100, durationMin: 100 }], 50);
  const recs = A.recommend(list, 50);
  assert.equal(recs.length, 1);
});

test('没有可用方案时推荐为空', () => {
  assert.deepEqual(A.recommend([], 50), []);
});

test('统计：能算出比最便宜直达省多少', () => {
  const list = A.score(
    [
      { key: 'd', code: 'D', price: 500, durationMin: 300, transferCount: 0 },
      { key: 't', code: 'T', price: 400, durationMin: 320, transferCount: 1 },
    ],
    50
  );
  const s = A.stats(list);
  assert.equal(s.count, 2);
  assert.equal(s.directCount, 1);
  assert.equal(s.transferCount, 1);
  assert.equal(s.cheapestDirect, 500);
  assert.equal(s.minPrice, 400);
  assert.equal(s.savedVsCheapestDirect, 100);
});

test('统计：没有直达时省钱幅度为 null', () => {
  const list = A.score([{ key: 't', code: 'T', price: 400, durationMin: 300, transferCount: 1 }], 50);
  const s = A.stats(list);
  assert.equal(s.cheapestDirect, null);
  assert.equal(s.savedVsCheapestDirect, null);
});

test('统计：空列表不报错', () => {
  const s = A.stats([]);
  assert.equal(s.count, 0);
  assert.equal(s.minPrice, null);
});
