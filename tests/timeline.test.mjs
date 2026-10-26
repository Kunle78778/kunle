/**
 * timeline.test.mjs —— 时间轴可视化测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import '../assets/algo.js';
import '../assets/timeline.js';

const T = globalThis.KunleTimeline;
const A = globalThis.KunleAlgo;

const directOption = () => ({
  code: 'G1',
  depart: '06:30',
  arrive: '11:24',
  durationMin: 294,
  fromStation: '北京南',
  toStation: '上海虹桥',
  transferCount: 0,
  waits: [],
  legs: [{ code: 'G1', from: '北京南', to: '上海虹桥', depart: '06:30', arrive: '11:24', durationMin: 294, price: 598 }],
});

const transferOption = () => ({
  code: 'G801 + G1801',
  depart: '07:00',
  arrive: '15:00',
  durationMin: 480,
  transferCount: 1,
  waits: [100],
  legs: [
    { code: 'G801', from: '北京南', to: '郑州东', depart: '07:00', arrive: '09:30', durationMin: 150, price: 309 },
    { code: 'G1801', from: '郑州东', to: '南京南', depart: '11:10', arrive: '15:00', durationMin: 230, price: 230 },
  ],
});

test('直达方案只有一个乘车片段', () => {
  const segs = T.segments(directOption());
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'ride');
  assert.equal(segs[0].minutes, 294);
});

test('中转方案包含乘车与等待片段', () => {
  const segs = T.segments(transferOption());
  assert.equal(segs.length, 3);
  assert.deepEqual(
    segs.map((s) => s.type),
    ['ride', 'wait', 'ride']
  );
  assert.equal(segs[1].minutes, 100);
});

test('片段总时长等于方案总耗时', () => {
  const segs = T.segments(transferOption());
  const sum = segs.reduce((s, x) => s + x.minutes, 0);
  assert.equal(sum, transferOption().durationMin);
});

test('没有分段时返回空数组', () => {
  assert.deepEqual(T.segments(null), []);
  assert.deepEqual(T.segments({ legs: [] }), []);
});

test('layout 按比例分配宽度', () => {
  const segs = T.segments(transferOption());
  const { items, total } = T.layout(segs, 700, { gap: 0, minWidth: 1 });
  assert.equal(total, 480);
  assert.equal(items.length, 3);
  const ride1 = items[0];
  const wait = items[1];
  assert.ok(ride1.width > wait.width, '150 分钟的段应比 100 分钟的宽');
});

test('layout 保证最小宽度', () => {
  const segs = [
    { type: 'ride', minutes: 1000 },
    { type: 'wait', minutes: 1 },
  ];
  const { items } = T.layout(segs, 400, { gap: 0, minWidth: 30 });
  assert.ok(items.every((i) => i.width >= 30));
});

test('layout 处理空输入', () => {
  const r = T.layout([], 500);
  assert.deepEqual(r.items, []);
});

test('layout 片段依次排布不重叠', () => {
  const segs = T.segments(transferOption());
  const { items } = T.layout(segs, 600, { gap: 6 });
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i].x >= items[i - 1].x + items[i - 1].width, '后一段应在上一段右侧');
  }
});

test('toSvg 输出合法 SVG 结构', () => {
  const svg = T.toSvg(transferOption(), { width: 600, height: 90 });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('</svg>'));
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.includes('G801'));
});

test('toSvg 转义标题中的特殊字符', () => {
  const opt = directOption();
  opt.legs[0].from = '<站名>';
  const svg = T.toSvg(opt, { width: 400 });
  assert.ok(!svg.includes('<站名>'));
  assert.ok(svg.includes('&lt;站名&gt;'));
});

test('toSvg 无分段时返回空串', () => {
  assert.equal(T.toSvg({ legs: [] }), '');
});

test('formatMinutes 人类可读', () => {
  assert.equal(T.formatMinutes(90), '1小时30分');
  assert.equal(T.formatMinutes(45), '45分');
  assert.equal(T.formatMinutes(null), '—');
});

test('与算法模块联动：真实方案能渲染时间轴', () => {
  const rows = [
    { code: 'G801', fromStation: '北京南', toStation: '郑州东', depart: '07:00', arrive: '09:30', durationMin: 150, price: 309, group: 'leg1' },
    { code: 'G1801', fromStation: '郑州东', toStation: '南京南', depart: '11:10', arrive: '15:00', durationMin: 230, price: 230, group: 'leg2' },
  ];
  const { options } = A.buildChains([[], [rows[0]], [rows[1]]]);
  const t = options.find((o) => o.transferCount === 1);
  const segs = T.segments(t);
  assert.equal(segs.length, 3);
  assert.equal(segs.reduce((s, x) => s + x.minutes, 0), t.durationMin);
});
