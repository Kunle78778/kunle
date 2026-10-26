/**
 * store.test.mjs —— 本地存储（设置 / 历史 / 导入导出）测试
 *
 * Node 环境没有 localStorage，store.js 会自动降级为内存实现，
 * 因此这里测的是同一套逻辑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import '../assets/store.js';
const S = globalThis.KunleStore;

test('默认设置包含权重与筛选', () => {
  const s = S.loadSettings();
  assert.equal(typeof s.weight, 'number');
  assert.equal(typeof s.minTransfer, 'number');
  assert.ok(s.filters && typeof s.filters === 'object');
});

test('保存设置后能读回', () => {
  S.saveSettings({ weight: 80, hub: '南京' });
  const s = S.loadSettings();
  assert.equal(s.weight, 80);
  assert.equal(s.hub, '南京');
});

test('合并筛选条件不覆盖其他字段', () => {
  S.saveSettings({ weight: 70, filters: { seatKeyword: '二等座' } });
  S.saveSettings({ filters: { maxPrice: 300 } });
  const s = S.loadSettings();
  assert.equal(s.weight, 70);
  assert.equal(s.filters.seatKeyword, '二等座');
  assert.equal(s.filters.maxPrice, 300);
});

test('resetSettings 恢复默认', () => {
  S.saveSettings({ weight: 12 });
  const s = S.resetSettings();
  assert.equal(s.weight, S.DEFAULT_SETTINGS.weight);
});

test('保存历史快照并读回', () => {
  S.clearHistory();
  const entry = S.saveSnapshot({
    rows: [{ code: 'G1' }, { code: 'G3' }],
    hub: '郑州',
    weight: 55,
    minTransfer: 30,
    maxWait: 480,
    maxLegs: 2,
    summary: { options: 5, minPrice: 498 },
  });
  assert.ok(entry.id);
  const list = S.loadHistory();
  assert.equal(list.length, 1);
  assert.equal(list[0].rows.length, 2);
  assert.equal(list[0].hub, '郑州');
});

test('历史记录按时间倒序', () => {
  S.clearHistory();
  S.saveSnapshot({ rows: [{ code: 'A' }] });
  S.saveSnapshot({ rows: [{ code: 'B' }] });
  const list = S.loadHistory();
  assert.equal(list[0].rows[0].code, 'B');
});

test('历史数量不超过上限', () => {
  S.clearHistory();
  for (let i = 0; i < S.HISTORY_LIMIT + 5; i++) {
    S.saveSnapshot({ rows: [{ code: 'G' + i }] });
  }
  assert.equal(S.loadHistory().length, S.HISTORY_LIMIT);
});

test('删除单条历史', () => {
  S.clearHistory();
  const a = S.saveSnapshot({ rows: [{ code: 'A' }] });
  S.saveSnapshot({ rows: [{ code: 'B' }] });
  const rest = S.removeSnapshot(a.id);
  assert.equal(rest.length, 1);
  assert.ok(!rest.some((x) => x.id === a.id));
});

test('清空历史', () => {
  S.clearHistory();
  S.saveSnapshot({ rows: [{ code: 'A' }] });
  S.clearHistory();
  assert.deepEqual(S.loadHistory(), []);
});

test('非法快照被拒绝', () => {
  S.clearHistory();
  assert.equal(S.saveSnapshot(null), null);
  assert.equal(S.saveSnapshot({ rows: 'not-array' }), null);
  assert.equal(S.loadHistory().length, 0);
});

test('导出数据包含设置与历史', () => {
  S.clearHistory();
  S.saveSettings({ weight: 66 });
  S.saveSnapshot({ rows: [{ code: 'G1' }] });
  const json = JSON.parse(S.exportAll());
  assert.equal(json.version, 2);
  assert.equal(json.settings.weight, 66);
  assert.equal(json.history.length, 1);
});

test('导入数据可恢复设置与历史', () => {
  S.clearHistory();
  const payload = JSON.stringify({
    version: 2,
    settings: { weight: 33, filters: { seatKeyword: '硬座' } },
    history: [{ id: 'x1', createdAt: new Date().toISOString(), rows: [{ code: 'G9' }], summary: {} }],
  });
  const result = S.importAll(payload, { merge: false });
  assert.equal(result.settings.weight, 33);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].rows[0].code, 'G9');
});

test('导入非法 JSON 抛出可读错误', () => {
  assert.throws(() => S.importAll('{不是 json'), /JSON/);
});

test('summarise 统计各分组数量', () => {
  const sum = S.summarise(
    [{ group: 'direct' }, { group: 'direct' }, { group: 'leg1' }],
    [{}, {}]
  );
  assert.equal(sum.rows, 3);
  assert.equal(sum.groups.direct, 2);
  assert.equal(sum.groups.leg1, 1);
  assert.equal(sum.options, 2);
});
