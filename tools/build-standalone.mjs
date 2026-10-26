/**
 * build-standalone.mjs —— 把整个应用打包成「单个 HTML 文件」
 *
 * 为什么需要：
 *   - 手机上访问 GitHub Pages 需要科学上网；而 OCR 又必须依赖本机 Windows 服务。
 *   - 所以「把车次粘进去算最优方案」这件事，完全可以离线在手机上完成。
 *
 * 产物：standalone.html（仓库根目录）
 *   - CSS / JS 全部内联，无任何外部请求
 *   - 不注册 Service Worker（file:// 下不可用）
 *   - 保留：粘贴文本、CSV 导入、计算、图表、时间轴、筛选、历史、报告导出、打印
 *   - 不可用：截图 OCR（需要本机 Node 服务）
 *
 * 用法：node tools/build-standalone.mjs   或   npm run build
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 直接输出到仓库根目录：手机/局域网可直接打开，也会随 Pages 一起发布
const OUT_FILE = path.join(ROOT, 'standalone.html');

const SCRIPTS = [
  'assets/parse.js',
  'assets/algo.js',
  'assets/store.js',
  'assets/chart.js',
  'assets/timeline.js',
  'assets/validate.js',
  'assets/report.js',
  'assets/a11y.js',
  'assets/app.js',
];

async function read(rel) {
  return readFile(path.join(ROOT, rel), 'utf8');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  let html = await read('index.html');

  // 1. 内联样式
  const css = await read('assets/styles.css');
  html = html.replace(
    /<link rel="stylesheet" href="assets\/styles\.css[^"]*"\s*\/?>/,
    `<style>\n${css}\n</style>`
  );

  // 2. 去掉 PWA 清单（单文件模式下没有意义）
  html = html.replace(/<link rel="manifest"[^>]*>\s*/i, '');

  // 3. 按顺序内联脚本
  for (const rel of SCRIPTS) {
    const code = await read(rel);
    const re = new RegExp(`<script src="${escapeRe(rel)}[^"]*"></script>`);
    if (!re.test(html)) {
      console.warn(`警告：未找到脚本标签 ${rel}`);
      continue;
    }
    html = html.replace(re, `<script>\n${code}\n</script>`);
  }

  // 4. 标记单文件模式（app.js 会据此关闭网络相关功能）
  html = html.replace('<head>', '<head>\n<script>window.__KUNLE_STANDALONE__ = true;</script>');

  // 5. 头部加一个离线版徽标，避免误以为 OCR 坏了
  html = html.replace(
    '<div class="header-actions">',
    `<div class="header-actions">
      <span class="badge badge-muted" title="离线单文件版：不含截图识别">离线版</span>`
  );

  await writeFile(OUT_FILE, html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`已生成：standalone.html  (${kb} KB)`);
  console.log('发给手机后用浏览器打开即可；支持粘贴文本 / CSV / 计算 / 图表 / 报告导出。');
}

main().catch((err) => {
  console.error('打包失败：', err);
  process.exit(1);
});
