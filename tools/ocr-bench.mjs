/**
 * ocr-bench.mjs —— OCR 基准测试
 *
 * 对 tests/fixtures 下的四类图片跑一遍完整链路（上传 → OCR → 解析），
 * 统计「识别出的车次」与「期望车次」的匹配情况，用于评估预处理改动的效果。
 *
 * 用法：
 *   node tools/ocr-bench.mjs            # 用本地服务 http://127.0.0.1:8787
 *   node tools/ocr-bench.mjs --verbose  # 打印识别到的原始文字
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.KUNLE_BASE || 'http://127.0.0.1:8787';
const VERBOSE = process.argv.includes('--verbose');

await import('file:///' + path.join(ROOT, 'assets', 'parse.js').replace(/\\/g, '/'));
const P = globalThis.KunleParse;

const CASES = [
  { file: 'table.png', expect: ['G1', 'G3', 'D709'], label: '横排表格' },
  { file: 'lowres.png', expect: ['G1', 'G3', 'D709'], label: '低分辨率小字' },
  { file: 'dark.png', expect: ['G1', 'G3', 'D709'], label: '深色背景' },
  { file: 'card.png', expect: ['G1', 'G3'], label: '竖排卡片' },
];

async function ocr(file) {
  const buf = await readFile(path.join(ROOT, 'tests', 'fixtures', file));
  const res = await fetch(`${BASE}/api/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: buf,
  });
  return res.json();
}

/** 与前端一致：多个变体各解析一遍取最优，再用左列补识补齐缺失车次 */
function pickRows(data) {
  const sources = [];
  if (Array.isArray(data.variants) && data.variants.length) {
    for (const v of data.variants) sources.push(v.lines || []);
  } else {
    sources.push(data.lines || []);
  }
  let best = [];
  let bestScore = -1;
  for (const lines of sources) {
    const rows = P.fromOcrLines(lines);
    const score = P.scoreRows(rows) + rows.length * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = rows;
    }
  }

  // 左列条补识
  const strip = data.stripVariant;
  if (strip && Array.isArray(strip.lines) && strip.lines.length) {
    const stripH = Number(strip.height) || 0;
    const mainH = Number(data.height) || 0;
    const hints = [];
    for (const line of strip.lines) {
      const code = P.fixTrainCode(P.normalize(line.text || ''));
      if (!code) continue;
      const ratio = ((Number(line.y) || 0) + (Number(line.h) || 0) / 2) / (stripH || 1);
      hints.push({ code, y: ratio * mainH, used: false });
    }
    const tol = Math.max(24, mainH * 0.08);
    for (const row of best) {
      if (row.code) continue;
      let pick = null;
      let bestD = Infinity;
      for (const h of hints) {
        if (h.used) continue;
        const d = Math.abs(h.y - (row.y || 0));
        if (d < bestD) {
          bestD = d;
          pick = h;
        }
      }
      if (pick && bestD <= tol) {
        row.code = pick.code;
        pick.used = true;
      }
    }
  }

  return best;
}

function checkRows(rows, expect) {  const got = rows.map((r) => (r.code || '').toUpperCase()).filter(Boolean);
  const hit = expect.filter((c) => got.includes(c));
  const extra = got.filter((c) => !expect.includes(c));
  return { got: rows.map((r) => r.code || '(空)'), hit, extra, ok: hit.length === expect.length };
}

async function main() {
  console.log(`OCR 基准测试 @ ${BASE}\n`);

  let totalExpect = 0;
  let totalHit = 0;
  let passFiles = 0;
  const rowsOut = [];

  for (const c of CASES) {
    const t0 = Date.now();
    const data = await ocr(c.file);
    const ms = Date.now() - t0;

    if (!data.ok) {
      console.log(`✖ ${c.label.padEnd(8)} 识别失败：${data.error}`);
      totalExpect += c.expect.length;
      continue;
    }

    const rows = pickRows(data);
    const r = checkRows(rows, c.expect);
    totalExpect += c.expect.length;
    totalHit += r.hit.length;
    if (r.ok) passFiles++;

    console.log(
      `${r.ok ? '✔' : '✖'} ${c.label.padEnd(8)} 期望 ${c.expect.join(',')} ｜ 得到 ${r.got.join(',') || '(无)'}` +
        ` ｜ 变体 ${data.variant} 分数 ${data.score} ｜ ${ms}ms`
    );

    if (VERBOSE || !r.ok) {
      const lines = (data.lines || []).slice().sort((a, b) => a.y - b.y || a.x - b.x);
      console.log('   识别原文：' + lines.map((l) => l.text).join(' ｜ '));
      for (const row of rows) {
        console.log(
          `   解析：code=${row.code || '(空)'} ${row.fromStation} ${row.depart}→${row.arrive} ` +
            `${row.toStation} dur=${row.durationMin} price=${row.price}`
        );
      }
    }
    rowsOut.push({ file: c.file, rows });
  }

  const rate = totalExpect ? Math.round((totalHit / totalExpect) * 100) : 0;
  console.log(`\n车次命中 ${totalHit}/${totalExpect}（${rate}%），图片通过 ${passFiles}/${CASES.length}`);

  await writeFile(
    path.join(ROOT, 'tests', 'fixtures', 'last-result.json'),
    JSON.stringify({ at: new Date().toISOString(), rate, passFiles, rowsOut }, null, 2),
    'utf8'
  );

  process.exit(rate === 100 ? 0 : 1);
}

main().catch((e) => {
  console.error('基准测试异常：', e.message);
  process.exit(2);
});
