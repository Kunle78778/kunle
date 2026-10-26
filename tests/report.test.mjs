/**
 * report.test.mjs —— 报告生成与自动洞察测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import '../assets/report.js';
const R = globalThis.KunleReport;

const options = () => [
  {
    key: 'd1', code: 'G1', price: 598, durationMin: 294, score: 0.5, pareto: true,
    depart: '06:30', arrive: '11:24', transferCount: 0, waitMin: 0,
    fromStation: '北京南', toStation: '上海虹桥', legs: [], overnight: false,
  },
  {
    key: 'd2', code: '1461', price: 156.5, durationMin: 1126, score: 0.7, pareto: true,
    depart: '11:59', arrive: '06:45', transferCount: 0, waitMin: 0,
    fromStation: '北京', toStation: '上海', legs: [], overnight: true,
  },
  {
    key: 't1', code: 'G801 + G1801', price: 539, durationMin: 480, score: 0.6, pareto: true,
    depart: '07:00', arrive: '15:00', transferCount: 1, waitMin: 100, hub: '郑州东',
    fromStation: '北京南', toStation: '南京南', overnight: false,
    legs: [
      { code: 'G801', from: '北京南', to: '郑州东', depart: '07:00', arrive: '09:30', price: 309 },
      { code: 'G1801', from: '郑州东', to: '南京南', depart: '11:10', arrive: '15:00', price: 230 },
    ],
  },
];

test('洞察：指出最便宜方案与直达的价差', () => {
  const list = R.insights(options());
  assert.ok(list.some((i) => i.text.includes('少花') || i.text.includes('持平')));
});

test('洞察：识别跨夜方案', () => {
  const list = R.insights(options());
  assert.ok(list.some((i) => i.level === 'warn' && i.text.includes('跨夜')));
});

test('洞察：输出 Pareto 规模', () => {
  const list = R.insights(options());
  assert.ok(list.some((i) => i.text.includes('性价比前沿')));
});

test('洞察：空方案返回空数组', () => {
  assert.deepEqual(R.insights([]), []);
});

test('Markdown 包含标题与参数', () => {
  const md = R.markdown(options(), { weight: 60, minTransfer: 30, maxLegs: 2, hub: '郑州' });
  assert.ok(md.includes('# 车票最优方案报告'));
  assert.ok(md.includes('权重 60% 省钱'));
  assert.ok(md.includes('郑州'));
});

test('Markdown 包含推荐与表格', () => {
  const md = R.markdown(options(), {});
  assert.ok(md.includes('## 推荐结论'));
  assert.ok(md.includes('## 方案明细'));
  assert.ok(md.includes('| # | 车次 |'));
});

test('Markdown 列出中转明细', () => {
  const list = options();
  // 让中转方案成为综合最优，从而出现在推荐区块里
  list[2].score = 0.1;
  const md = R.markdown(list, {});
  assert.ok(md.includes('G1801'));
  assert.ok(md.includes('换乘等待'));
});

test('Markdown 处理空方案不崩溃', () => {
  const md = R.markdown([], {});
  assert.ok(md.includes('# 车票最优方案报告'));
});

test('HTML 报告结构完整', () => {
  const page = R.html(options(), { hub: '郑州' });
  assert.ok(page.startsWith('<!DOCTYPE html>'));
  assert.ok(page.includes('车票最优方案报告'));
  assert.ok(page.includes('<table>'));
  assert.ok(page.includes('郑州'));
});

test('HTML 转义危险字符', () => {
  const list = options();
  list[0].code = '<script>alert(1)</script>';
  const page = R.html(list, {});
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.ok(page.includes('&lt;script&gt;'));
});

test('fileName 生成带扩展名的文件名', () => {
  const name = R.fileName('md');
  assert.match(name, /^kunle-方案报告-\d{8}-\d{4}\.md$/);
  assert.match(R.fileName('html'), /\.html$/);
});

test('routeText 拼接中转路线', () => {
  assert.equal(R.routeText(options()[2]), '北京南 → 郑州东 → 南京南');
  assert.equal(R.routeText(options()[0]), '北京南 → 上海虹桥');
});

test('buildMeta 填充默认值', () => {
  const meta = R.buildMeta({});
  assert.equal(meta.weight, 55);
  assert.equal(meta.minTransfer, 30);
  assert.equal(meta.maxLegs, 2);
  assert.equal(meta.topN, 15);
});
