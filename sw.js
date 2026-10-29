/**
 * sw.js —— Service Worker：离线可用 + 可安装
 *
 * 重要：这里用「网络优先」而不是「缓存优先」。
 *
 * 原因：之前版本用缓存优先（stale-while-revalidate），升级后浏览器会先拿旧版
 * index.html 与新版 app.js 混着跑，导致界面元素与事件监听对不上——表现为
 * 按钮点了没反应、弹层关不掉。现在改为：
 *   - 导航请求（HTML）与脚本/样式：先请求网络，成功后写入缓存；离线才回退缓存
 *   - 图标等静态资源：缓存优先
 *   - 每次发版提升 VERSION，激活时清掉所有旧缓存
 */

const VERSION = 'kunle-v8';
const CACHE = `static-${VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './assets/styles.css',
  './assets/app.js',
  './assets/algo.js',
  './assets/parse.js',
  './assets/store.js',
  './assets/chart.js',
  './assets/timeline.js',
  './assets/validate.js',
  './assets/report.js',
  './assets/a11y.js',
  './assets/icon.svg',
];
// 注意：reset.html 故意不预缓存，保证它永远拿到最新版本

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((a) => new URL(a, self.location).href)))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 页面可以主动要求立即接管新版本
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

const NETWORK_FIRST = /\.(html|js|css|json)$/;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // 本机 API 一律走网络，不缓存
  if (url.pathname.startsWith('/api/')) return;

  const isNavigation = req.mode === 'navigate';
  const networkFirst = isNavigation || NETWORK_FIRST.test(url.pathname);

  if (networkFirst) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req, { ignoreSearch: true });
          if (cached) return cached;
          if (isNavigation) {
            const shell = await caches.match(new URL('./index.html', self.location).href);
            if (shell) return shell;
          }
          return new Response('离线且没有缓存', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        })
    );
    return;
  }

  // 其余静态资源：缓存优先
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached)
    )
  );
});
