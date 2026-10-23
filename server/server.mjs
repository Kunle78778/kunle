/**
 * server.mjs —— 本地开发/自用服务器
 *
 * 作用：
 *   1. 托管前端的静态文件（index.html / assets/*）
 *   2. 把 /api/* 转发给 12306（浏览器无法直连 12306，因为对方没有 CORS 头）
 *
 * 用法：
 *   node server/server.mjs
 *   然后浏览器打开 http://127.0.0.1:8787
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';

import { search, searchCities } from '../shared/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(data);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }).end();
    return;
  }

  try {
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'kunle-ticket', time: new Date().toISOString() });
      return;
    }

    if (url.pathname === '/api/cities') {
      const q = url.searchParams.get('q') || '';
      const cities = await searchCities(q, Number(url.searchParams.get('limit') || 12));
      sendJson(res, 200, { ok: true, cities });
      return;
    }

    if (url.pathname === '/api/search') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const date = url.searchParams.get('date');
      const transfer = ['1', 'true', 'yes'].includes(
        String(url.searchParams.get('transfer') || '').toLowerCase()
      );

      if (!from || !to || !date) {
        sendJson(res, 400, { ok: false, error: '缺少参数：from / to / date' });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        sendJson(res, 400, { ok: false, error: '日期格式应为 YYYY-MM-DD' });
        return;
      }

      console.log(`[search] ${from} -> ${to} ${date} transfer=${transfer}`);
      const result = await search({ from, to, date, transfer });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[error]', err);
    sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, () => {
  console.log(`kunle 车票助手已启动:  http://127.0.0.1:${PORT}`);
  console.log('提示：首次查询需要从 12306 拉取车站表，稍等片刻。');
});
