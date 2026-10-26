/**
 * sw.js —— Service Worker：让页面可离线打开、可安装到桌面
 *
 * 策略：
 *   - 静态资源（HTML/CSS/JS/图标）：stale-while-revalidate，先给缓存再后台更新
 *   - /api/* ：直接走网络，绝不缓存（OCR 是本地实时计算）
 */

const VERSION = 'kunle-v3';
const CACHE = `static-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/styles.css',
  './assets/app.js',
  './assets/algo.js',
  './assets/parse.js',
  './assets/store.js',
  './assets/chart.js',
  './assets/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((a) => new URL(a, self.location).href)))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 只处理同源 GET
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // API 一律走网络
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });

      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
