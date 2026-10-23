/**
 * worker.js —— Cloudflare Worker 版代理
 *
 * 为什么需要它：
 *   GitHub Pages 只能托管静态文件，而 12306 接口不带 CORS 头，
 *   浏览器直连会被拦。把这份 Worker 部署上去，它就充当同源 API。
 *
 * 部署：
 *   cd worker
 *   npx wrangler deploy
 *   然后把拿到的 https://xxx.workers.dev 填进网页右上角「设置」。
 *
 * 注意：部分云厂商出口 IP 可能被 12306 限流或拦截。
 *       如果线上查询失败，请回退到本地 `node server/server.mjs` 使用。
 */

import { search, searchCities } from '../shared/core.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
      ...extra,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      // 健康检查
      if (url.pathname === '/api/health') {
        return json({ ok: true, service: 'kunle-ticket-worker', time: new Date().toISOString() });
      }

      // 城市联想
      if (url.pathname === '/api/cities') {
        const cities = await searchCities(
          url.searchParams.get('q') || '',
          Number(url.searchParams.get('limit') || 12)
        );
        return json({ ok: true, cities });
      }

      // 核心查询
      if (url.pathname === '/api/search') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const date = url.searchParams.get('date');
        const transfer = ['1', 'true', 'yes'].includes(
          String(url.searchParams.get('transfer') || '').toLowerCase()
        );

        if (!from || !to || !date) {
          return json({ ok: false, error: '缺少参数：from / to / date' }, 400);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return json({ ok: false, error: '日期格式应为 YYYY-MM-DD' }, 400);
        }

        const result = await search({ from, to, date, transfer });
        return json({ ok: true, ...result });
      }

      if (url.pathname === '/' ) {
        return new Response(
          'kunle 车票助手 API 已运行。可用端点：/api/health, /api/cities?q=, /api/search?from=&to=&date=&transfer=1',
          { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } }
        );
      }

      return json({ ok: false, error: 'Not Found' }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};
