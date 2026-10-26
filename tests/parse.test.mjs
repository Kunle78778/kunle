/**
 * parse.test.mjs —— 解析层单元测试
 * 覆盖：文本归一化、车次号修正、单行抽取、OCR 聚类、粘贴文本解析
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import '../assets/parse.js';
const P = globalThis.KunleParse;

/* ---------------- 归一化 ---------------- */

test('normalize 把全角字符转半角', () => {
  assert.equal(P.normalize('０６：３０'), '06:30');
  assert.equal(P.normalize('Ｇ１'), 'G1');
});

test('normalize 统一货币符号并去掉空白', () => {
  assert.equal(P.normalize('￥ ５９８ ． ０'), '¥598.0');
});

test('normalize 把不可见间隔号当作小数点', () => {
  assert.equal(P.normalize('¥598·0'), '¥598.0');
});

/* ---------------- 车次号 ---------------- */

test('fixTrainCode 修正 OCR 常见错字', () => {
  assert.equal(P.fixTrainCode('GI'), 'G1');
  assert.equal(P.fixTrainCode('G5O1'), 'G501');
  assert.equal(P.fixTrainCode('D7O9'), 'D709');
});

test('fixTrainCode 保留合法车次', () => {
  assert.equal(P.fixTrainCode('G1'), 'G1');
  assert.equal(P.fixTrainCode('1461'), '1461');
  assert.equal(P.fixTrainCode('C2001'), 'C2001');
});

test('fixTrainCode 拒绝非车次文本', () => {
  assert.equal(P.fixTrainCode('北京南'), null);
  assert.equal(P.fixTrainCode('06:30'), null);
});

/* ---------------- 时间与价格 ---------------- */

test('parseTime 规范化时间', () => {
  assert.equal(P.parseTime('6:30'), '06:30');
  assert.equal(P.parseTime('06:30'), '06:30');
  assert.equal(P.parseTime('24:00'), null);
});

test('parsePrice 解析票价', () => {
  assert.equal(P.parsePrice('¥598.0'), 598);
  assert.equal(P.parsePrice('¥156.5'), 156.5);
  assert.equal(P.parsePrice('598'), null); // 没有货币符号不当作票价
});

/* ---------------- 单行抽取 ---------------- */

test('extractRow 从完整字段中抽取', () => {
  const row = P.extractRow(['G1', '北京南', '06:30', '04时54分', '11:24', '上海虹桥', '二等座 有', '¥598.0']);
  assert.equal(row.code, 'G1');
  assert.equal(row.fromStation, '北京南');
  assert.equal(row.toStation, '上海虹桥');
  assert.equal(row.depart, '06:30');
  assert.equal(row.arrive, '11:24');
  assert.equal(row.durationMin, 294);
  assert.equal(row.price, 598);
  assert.equal(row.seat.name, '二等座');
  assert.equal(row.seat.available, true);
});

test('extractRow 字段顺序打乱也能识别', () => {
  const row = P.extractRow(['¥667.0', '07:00', 'G3', '上海虹桥', '11:41', '北京南']);
  assert.equal(row.code, 'G3');
  assert.equal(row.price, 667);
  assert.equal(row.depart, '07:00');
  assert.equal(row.arrive, '11:41');
});

test('extractRow 没有历时用发到时刻推算', () => {
  const row = P.extractRow(['G1', '北京南', '上海虹桥', '06:30', '11:24', '¥598']);
  assert.equal(row.durationMin, 294);
});

test('extractRow 处理跨夜车次', () => {
  const row = P.extractRow(['D709', '北京南', '19:46', '上海虹桥', '07:45', '¥296']);
  assert.equal(row.durationMin, 719);
});

test('extractRow 没有车次号返回 null', () => {
  assert.equal(P.extractRow(['北京南', '06:30', '¥598']), null);
});

test('extractRow 识别无票席别', () => {
  const row = P.extractRow(['G7', '北京南', '08:00', '上海虹桥', '12:38', '二等座 无', '¥604']);
  assert.equal(row.seat.available, false);
});

/* ---------------- OCR 聚类 ---------------- */

test('fromOcrLines 按 y 坐标聚类成行', () => {
  const lines = [
    { text: 'G1', x: 50, y: 73, h: 44 },
    { text: '06：30', x: 247, y: 75, h: 44 },
    { text: '北 京 南', x: 407, y: 74, h: 44 },
    { text: '04 时 54 分', x: 615, y: 78, h: 44 },
    { text: '11 ： 24', x: 850, y: 76, h: 44 },
    { text: '上 海 虹 桥', x: 1055, y: 75, h: 44 },
    { text: '¥ 598 · 0', x: 1515, y: 74, h: 44 },
  ];
  const rows = P.fromOcrLines(lines);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'G1');
  assert.equal(rows[0].price, 598);
  assert.equal(rows[0].durationMin, 294);
});

test('fromOcrLines 多行截图逐行解析', () => {
  const lines = [];
  const data = [
    ['G1', '06:30', '北京南', '04时54分', '11:24', '上海虹桥', '¥598.0'],
    ['G3', '07:00', '北京南', '04时41分', '11:41', '上海虹桥', '¥667.0'],
    ['D709', '19:46', '北京南', '11时59分', '07:45', '上海虹桥', '¥296.0'],
  ];
  data.forEach((cols, rowIndex) => {
    cols.forEach((text, colIndex) => {
      lines.push({ text, x: 50 + colIndex * 180, y: 73 + rowIndex * 117, h: 44 });
    });
  });
  const rows = P.fromOcrLines(lines);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.code),
    ['G1', 'G3', 'D709']
  );
  assert.equal(rows[2].durationMin, 719);
});

test('fromOcrLines 空输入返回空数组', () => {
  assert.deepEqual(P.fromOcrLines([]), []);
  assert.deepEqual(P.fromOcrLines(null), []);
});

/* ---------------- 粘贴文本 ---------------- */

test('fromText 逗号分隔', () => {
  const rows = P.fromText('G1,北京南,上海虹桥,06:30,11:24,¥598');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'G1');
});

test('fromText 空格与制表符分隔', () => {
  const rows = P.fromText('G3\t北京南\t上海虹桥\t07:00\t11:41\t¥667');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 667);
});

test('fromText 多行混合分隔符', () => {
  const text = ['G1 北京南 上海虹桥 06:30 11:24 ¥598', 'G3|北京南|上海虹桥|07:00|11:41|¥667'].join('\n');
  const rows = P.fromText(text);
  assert.equal(rows.length, 2);
});

test('fromText 忽略空行与无效行', () => {
  const text = ['', 'G1 北京南 上海虹桥 06:30 11:24 ¥598', '   ', '这不是车次'].join('\n');
  const rows = P.fromText(text);
  assert.equal(rows.length, 1);
});

test('blankRow 提供表格初始结构', () => {
  const r = P.blankRow();
  assert.equal(r.code, '');
  assert.equal(r.price, null);
});
