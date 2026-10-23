/**
 * server.mjs —— 本地服务：托管页面 + 提供 OCR 接口
 *
 * 这里没有任何 12306 抓取逻辑：
 *   - 静态文件由本进程托管
 *   - 图片只送到本机 Windows 自带 OCR 引擎（server/ocr.ps1），不联网
 *   - 最优方案计算完全在浏览器里完成（assets/algo.js）
 *
 * 用法：node server/server.mjs   →  http://127.0.0.1:8787
 */

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const OCR_SCRIPT = path.join(__dirname, 'ocr.ps1');

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
};

/* ------------------------------------------------------------------ *
 * 启动时探测 OCR 引擎（只探测一次）
 * ------------------------------------------------------------------ */
let ocrAvailable = false;

function probeOcr() {
  return new Promise((resolve) => {
    const ps = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8;',
      '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime];',
      '(@([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages).Count)',
    ].join(' ');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        const n = Number(String(stdout || '').trim());
        resolve(!err && Number.isFinite(n) && n > 0);
      }
    );
  });
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('图片超过大小限制（12MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      res.writeHead(301, { Location: pathname.replace(/\/?$/, '/') + 'index.html' }).end();
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

/* ------------------------------------------------------------------ *
 * OCR：图片 → 文字行
 * ------------------------------------------------------------------ */
function runOcr(imagePath) {
  const outPath = imagePath.replace(/\.[^.]+$/, '') + '.json';
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        OCR_SCRIPT,
        '-Path',
        imagePath,
        '-OutFile',
        outPath,
      ],
      { windowsHide: true }
    );

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('OCR 超时（60 秒）'));
    }, 60000);

    child.on('close', async () => {
      clearTimeout(timer);
      try {
        const raw = await readFile(outPath, 'utf8');
        const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
        await unlink(outPath).catch(() => {});
        resolve(json);
      } catch (err) {
        reject(new Error(stderr.trim() || err.message || 'OCR 执行失败'));
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'kunle-ticket-local',
        ocr: ocrAvailable,
        time: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname === '/api/ocr') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '请使用 POST' });
        return;
      }
      if (!ocrAvailable) {
        sendJson(res, 503, { ok: false, error: '本机 OCR 引擎不可用，请改用「粘贴文本」录入' });
        return;
      }

      const body = await readBody(req, MAX_IMAGE_BYTES);
      if (!body.length) {
        sendJson(res, 400, { ok: false, error: '没有收到图片数据' });
        return;
      }

      const ext = EXT_BY_TYPE[String(req.headers['content-type'] || '').split(';')[0]] || '.png';
      const base = path.join(os.tmpdir(), 'kunle-ocr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      const imgPath = base + ext;
      await writeFile(imgPath, body);

      try {
        const result = await runOcr(imgPath);
        if (!result || result.ok !== true) {
          sendJson(res, 500, { ok: false, error: (result && result.error) || 'OCR 失败' });
          return;
        }
        console.log(`[ocr] ${body.length} bytes → ${result.lines.length} 行文本`);
        sendJson(res, 200, result);
      } finally {
        await unlink(imgPath).catch(() => {});
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: 'No such API' });
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[error]', err);
    sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
});

ocrAvailable = await probeOcr();

server.listen(PORT, () => {
  console.log(`kunle 车票最优助手已启动:  http://127.0.0.1:${PORT}`);
  console.log(`本地 OCR 引擎: ${ocrAvailable ? '可用（Windows.Media.Ocr）' : '不可用（请改用粘贴文本）'}`);
});
