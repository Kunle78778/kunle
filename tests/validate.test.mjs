/**
 * validate.test.mjs —— 数据校验测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import '../assets/validate.js';
const V = globalThis.KunleValidate;

const good = (over = {}) => ({
  id: 'r1',
  code: 'G1',
  fromStation: '北京南',
  toStation: '上海虹桥',
  depart: '06:30',
  arrive: '11:24',
  durationMin: 294,
  price: 598,
  group: 'direct',
  ...over,
});

test('合法行没有错误', () => {
  const issues = V.validateRow(good());
  assert.equal(issues.filter((i) => i.level === 'error').length, 0);
});

test('空行不报错', () => {
  const issues = V.validateRow({ id: 'x', code: '', depart: '', arrive: '', price: '' });
  assert.equal(issues.length, 0);
});

test('缺少车次号报错', () => {
  const issues = V.validateRow(good({ code: '' }));
  assert.ok(issues.some((i) => i.field === 'code' && i.level === 'error'));
});

test('车次格式异常给警告', () => {
  const issues = V.validateRow(good({ code: '高铁1号' }));
  assert.ok(issues.some((i) => i.level === 'warn'));
});

test('时间格式错误报错', () => {
  const issues = V.validateRow(good({ depart: '6点30' }));
  assert.ok(issues.some((i) => i.field === 'depart' && i.level === 'error'));
});

test('缺少到达时间给警告', () => {
  const issues = V.validateRow(good({ arrive: '' }));
  assert.ok(issues.some((i) => i.field === 'arrive' && i.level === 'warn'));
});

test('历时与时刻不一致给警告', () => {
  const issues = V.validateRow(good({ durationMin: 200 }));
  assert.ok(issues.some((i) => i.field === 'durationMin' && i.level === 'warn'));
});

test('历时为 0 报错', () => {
  const issues = V.validateRow(good({ durationMin: 0 }));
  assert.ok(issues.some((i) => i.field === 'durationMin' && i.level === 'error'));
});

test('票价为 0 报错', () => {
  const issues = V.validateRow(good({ price: 0 }));
  assert.ok(issues.some((i) => i.field === 'price' && i.level === 'error'));
});

test('未填票价给警告', () => {
  const issues = V.validateRow(good({ price: '' }));
  assert.ok(issues.some((i) => i.field === 'price' && i.level === 'warn'));
});

test('票价异常偏高给警告', () => {
  const issues = V.validateRow(good({ price: 9999 }));
  assert.ok(issues.some((i) => i.field === 'price' && i.level === 'warn'));
});

test('出发站与到达站相同报错', () => {
  const issues = V.validateRow(good({ fromStation: '上海', toStation: '上海' }));
  assert.ok(issues.some((i) => i.level === 'error'));
});

test('跨夜给提示', () => {
  const issues = V.validateRow(good({ depart: '19:46', arrive: '07:45', durationMin: 719 }));
  assert.ok(issues.some((i) => i.level === 'info'));
});

test('重复车次给警告', () => {
  const { issues } = V.validateRows([good(), good({ id: 'r2' })]);
  assert.ok(issues.some((i) => i.message.includes('重复车次')));
});

test('换乘站不衔接给警告', () => {
  const rows = [
    good({ id: 'a', code: 'G801', group: 'leg1', fromStation: '北京南', toStation: '郑州东' }),
    good({ id: 'b', code: 'G1801', group: 'leg2', fromStation: '南京南', toStation: '上海虹桥' }),
  ];
  const { issues } = V.validateRows(rows);
  assert.ok(issues.some((i) => i.message.includes('没有交集')));
});

test('换乘站衔接时不报衔接警告', () => {
  const rows = [
    good({ id: 'a', code: 'G801', group: 'leg1', fromStation: '北京南', toStation: '郑州东' }),
    good({ id: 'b', code: 'G1801', group: 'leg2', fromStation: '郑州东', toStation: '上海虹桥' }),
  ];
  const { issues } = V.validateRows(rows);
  assert.ok(!issues.some((i) => i.message.includes('没有交集')));
});

test('没有直达时给提示', () => {
  const rows = [good({ group: 'leg1' })];
  const { issues } = V.validateRows(rows);
  assert.ok(issues.some((i) => i.message.includes('没有直达')));
});

test('summary 统计各级别数量', () => {
  const { summary } = V.validateRows([good({ code: '' }), good({ id: 'r2', price: '' })]);
  assert.ok(summary.error >= 1);
  assert.ok(summary.warn >= 1);
  assert.equal(summary.total, summary.error + summary.warn + summary.info);
});

test('hasBlocking 标记是否含错误', () => {
  assert.equal(V.validateRows([good()]).hasBlocking, false);
  assert.equal(V.validateRows([good({ code: '' })]).hasBlocking, true);
});

test('问题按严重程度排序', () => {
  const { issues } = V.validateRows([good({ code: '', price: '' })]);
  const levels = issues.map((i) => i.level);
  const order = { error: 0, warn: 1, info: 2 };
  for (let i = 1; i < levels.length; i++) {
    assert.ok(order[levels[i - 1]] <= order[levels[i]]);
  }
});

test('byRow 把问题按行聚合', () => {
  const { issues } = V.validateRows([good({ code: '' })]);
  const map = V.byRow(issues);
  assert.ok(map.r1 && map.r1.length > 0);
});

test('toMinutes 校验时间', () => {
  assert.equal(V.toMinutes('06:30'), 390);
  assert.equal(V.toMinutes('24:00'), null);
});
