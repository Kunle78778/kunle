/**
 * gen-fixtures.mjs —— 生成 OCR 基准测试图片
 *
 * 覆盖四种典型情况：
 *   1. table   横排表格（标准截图）
 *   2. lowres  低分辨率小字（截得很小 / 被压缩）
 *   3. dark    深色背景
 *   4. card    竖排卡片（手机 App 常见版式）
 *
 * 用法：node tools/gen-fixtures.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'fixtures');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const TRAINS = [
  { code: 'G1', dep: '06:30', from: '北京南', arr: '11:24', to: '上海虹桥', dur: '04时54分', seat: '二等座 有', price: '¥598.0' },
  { code: 'G3', dep: '07:00', from: '北京南', arr: '11:41', to: '上海虹桥', dur: '04时41分', seat: '二等座 有', price: '¥667.0' },
  { code: 'D709', dep: '19:46', from: '北京南', arr: '07:45', to: '上海虹桥', dur: '11时59分', seat: '二等座 有', price: '¥296.0' },
];

/* ---------------- 版式 ---------------- */

const tableHtml = (dark) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:12px;width:780px;font-family:"Microsoft YaHei";
  background:${dark ? '#141821' : '#fff'};color:${dark ? '#e8ecf3' : '#111'}}
.row{display:flex;gap:14px;padding:12px 6px;align-items:center;
  border-bottom:1px solid ${dark ? '#2a3140' : '#e0e4ea'}}
.code{font-weight:700;font-size:21px;width:84px}
.tm{font-size:19px;width:66px}.st{font-size:17px;width:92px}
.dur{font-size:15px;width:100px;color:${dark ? '#a8b2c1' : '#555'}}
.seat{font-size:15px;width:100px;color:${dark ? '#4ade80' : '#059669'}}
.price{font-size:20px;font-weight:700;width:84px;text-align:right;color:${dark ? '#fbbf24' : '#b45309'}}
</style></head><body>
${TRAINS.map((t) => `<div class="row">
<span class="code">${t.code}</span><span class="tm">${t.dep}</span><span class="st">${t.from}</span>
<span class="dur">${t.dur}</span><span class="st">${t.arr}</span><span class="st">${t.to}</span>
<span class="seat">${t.seat}</span><span class="price">${t.price}</span></div>`).join('\n')}
</body></html>`;

const cardHtml = () => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:10px;width:430px;font-family:"Microsoft YaHei";background:#fff}
.card{border:1px solid #e0e4ea;border-radius:12px;padding:12px 14px;margin-bottom:10px}
.code{font-weight:700;font-size:22px;color:#1d4ed8}
.line{display:flex;justify-content:space-between;font-size:17px;margin-top:6px}
.meta{font-size:15px;color:#555;margin-top:6px;display:flex;justify-content:space-between}
.price{font-weight:700;color:#b45309}
</style></head><body>
${TRAINS.slice(0, 2).map((t) => `<div class="card">
  <div class="code">${t.code}</div>
  <div class="line"><span>${t.dep} ${t.from}</span><span>${t.arr} ${t.to}</span></div>
  <div class="meta"><span>${t.dur}</span><span class="price">${t.price}</span></div>
</div>`).join('\n')}
</body></html>`;

/* ---------------- 生成 ---------------- */

async function shot(name, html, { width, scale }) {
  const htmlPath = path.join(os.tmpdir(), `fixture_${name}.html`);
  const outPath = path.join(OUT, `${name}.png`);
  await writeFile(htmlPath, html, 'utf8');
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${width},${name === 'card' ? 420 : 300}`,
    `--force-device-scale-factor=${scale}`,
    `--screenshot=${outPath}`,
    'file:///' + htmlPath.replace(/\\/g, '/'),
  ];
  execFileSync(CHROME, args, { stdio: 'ignore' });
  console.log(`  ${name}.png  (${width}x? @${scale}x)`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log('生成基准图片：');
  await shot('table', tableHtml(false), { width: 800, scale: 2 });
  await shot('lowres', tableHtml(false), { width: 420, scale: 1 });
  await shot('dark', tableHtml(true), { width: 800, scale: 2 });
  await shot('card', cardHtml(), { width: 450, scale: 2 });
  console.log('完成，输出目录：tests/fixtures');
}

main().catch((e) => {
  console.error('生成失败：', e.message);
  process.exit(1);
});
