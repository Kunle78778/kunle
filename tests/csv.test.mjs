/**
 * csv.test.mjs —— CSV 导入导出测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import '../assets/parse.js';
const P = globalThis.KunleParse;

const sampleRows = () => [
  { code: 'G1', fromStation: '北京南', toStation: '上海虹桥', depart: '06:30', arrive: '11:24', durationMin: 294, price: 598, seatText: '二等座 有', group: 'direct' },
  { code: 'G801', fromStation: '北京南', toStation: '郑州东', depart: '07:00', arrive: '09:30', durationMin: 150, price: 309, seatText: '二等座 有', group: 'leg1' },
];

test('toCSV 生成表头与数据行', () => {
  const csv = P.toCSV(sampleRows());
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('车次,'));
  assert.ok(lines[1].includes('G1'));
});

test('toCSV 转义含逗号的字段', () => {
  const csv = P.toCSV([{ code: 'G1', fromStation: '北京,南', group: 'direct' }]);
  assert.ok(csv.includes('"北京,南"'));
});

test('toCSV 转义引号', () => {
  const csv = P.toCSV([{ code: 'G1', fromStation: '带"引号"站', group: 'direct' }]);
  assert.ok(csv.includes('""引号""'));
});

test('CSV 往返保持一致', () => {
  const rows = sampleRows();
  const parsed = P.fromCSV(P.toCSV(rows));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].code, 'G1');
  assert.equal(parsed[0].price, 598);
  assert.equal(parsed[1].group, 'leg1');
});

test('fromCSV 支持英文表头', () => {
  const csv = 'code,fromStation,toStation,depart,arrive,price\nG3,北京南,上海虹桥,07:00,11:41,667';
  const rows = P.fromCSV(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'G3');
  assert.equal(rows[0].price, 667);
});

test('fromCSV 无表头时按字段猜测', () => {
  const csv = 'G1,北京南,上海虹桥,06:30,11:24,598';
  const rows = P.fromCSV(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'G1');
});

test('fromCSV 跳过没有车次的行', () => {
  const csv = '车次,出发站,到达站\n,北京南,上海虹桥\nG1,北京南,上海虹桥';
  const rows = P.fromCSV(csv);
  assert.equal(rows.length, 1);
});

test('fromCSV 支持引号内的分隔符', () => {
  const csv = '车次,出发站,到达站\nG1,"北京,南",上海虹桥';
  const rows = P.fromCSV(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fromStation, '北京,南');
});

test('fromCSV 空文本返回空数组', () => {
  assert.deepEqual(P.fromCSV(''), []);
});

test('splitCsvLine 处理转义引号', () => {
  assert.deepEqual(P.splitCsvLine('a,"b""c",d'), ['a', 'b"c', 'd']);
});

test('csvEscape 对普通值不加引号', () => {
  assert.equal(P.csvEscape('G1'), 'G1');
});
