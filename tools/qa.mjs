/**
 * qa.mjs —— 端到端冒烟测试（不需要 puppeteer，直接用 Chrome DevTools Protocol）
 *
 * 做法：
 *   1. 用无头 Chrome 打开页面（独立 user-data-dir，避免受本地 Service Worker 缓存影响）
 *   2. 通过 CDP 的 Runtime.evaluate 真实点击/修改控件，断言 DOM 状态
 *   3. 同时收集浏览器控制台错误与未捕获异常
 *
 * 用法：node tools/qa.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:8787/?demo=1';
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333 + Math.floor(Math.random() * 200);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const icon = ok ? '✔' : '✖';
  console.log(`${icon} ${name}${detail ? '  →  ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 300 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 忽略，继续等 */
    }
    await sleep(interval);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * CDP 客户端
 * ------------------------------------------------------------------ */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 20000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'JS 执行异常');
    }
    return r.result.value;
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  // 1. 确认本地服务在线
  const health = await fetch('http://127.0.0.1:8787/api/health')
    .then((r) => r.json())
    .catch(() => null);
  if (!health || !health.ok) {
    console.error('本地服务未运行，请先执行：node server/server.mjs');
    process.exit(2);
  }
  console.log(`服务在线：ocr=${health.ocr}`);

  // 2. 启动无头 Chrome
  const userDir = await mkdtemp(path.join(tmpdir(), 'kunle-qa-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDir}`,
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const version = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok ? r.json() : null;
  });
  if (!version) {
    console.error('无法连接 Chrome 调试端口');
    chrome.kill();
    process.exit(2);
  }

  // 3. 打开测试页面
  const target = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_UNDER_TEST)}`,
    { method: 'PUT' }
  ).then((r) => r.json());

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  // 4. 等页面完成渲染
  const ready = await waitFor(async () =>
    cdp.eval(`return document.readyState === 'complete' && document.querySelectorAll('.item').length > 0`)
  );
  check('页面加载并渲染方案', Boolean(ready));
  if (!ready) {
    console.log('页面没有渲染出方案，输出当前 DOM 片段以便排查');
    const html = await cdp.eval(`return document.body.innerText.slice(0, 500)`);
    console.log(html);
  }

  try {
  const n = await cdp.eval(`return document.querySelectorAll('.item').length`);
  check('示例数据生成 17 个方案', n === 17, `实际 ${n}`);

  /* ---- 回归：方案对比必须彻底不存在 ---- */
  const compareGone = await cdp.eval(`
    return !document.getElementById('compareModal')
      && !document.getElementById('compareBar')
      && !document.querySelector('[data-compare]')
      && !document.body.innerHTML.includes('并排对比');
  `);
  check('方案对比已完全移除（不会残留关不掉的弹层）', compareGone);

  /* ---- 关键模块已加载 ---- */
  const modules = await cdp.eval(`
    return ['KunleParse','KunleAlgo','KunleStore','KunleChart','KunleTimeline','KunleValidate','KunleReport','KunleA11y']
      .filter((k) => !window[k]).join(',');
  `);
  check('八个模块全部加载', modules === '', modules ? '缺少：' + modules : '');

  /* ---- 筛选：票价上限 ---- */
  const filterOk = await cdp.eval(`
    const input = document.getElementById('fMaxPrice');
    input.value = '300';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const items = [...document.querySelectorAll('.item .price')].map(e => e.textContent);
    const nums = items.map(t => Number(String(t).replace(/[^0-9.]/g, ''))).filter(v => Number.isFinite(v));
    return { count: items.length, max: nums.length ? Math.max(...nums) : 0 };
  `);
  check('票价上限筛选生效', filterOk.count > 0 && filterOk.max <= 300, JSON.stringify(filterOk));

  // 还原筛选
  await cdp.eval(`
    document.getElementById('resetFiltersBtn').click();
    await new Promise(r => setTimeout(r, 120));
    return true;
  `);

  /* ---- 权重滑块影响排序结果 ---- */
  const weightOk = await cdp.eval(`
    const set = async (v) => {
      const s = document.getElementById('weightInput');
      s.value = String(v);
      s.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 180));
      // 综合排序下的第一名应该随权重改变
      const first = document.querySelector('.item .train-code');
      const price = document.querySelector('.item .price');
      return (first ? first.textContent : '') + '/' + (price ? price.textContent.trim() : '');
    };
    const a = await set(100);
    const b = await set(0);
    return { cheapFirst: a, timeFirst: b, changed: a !== b };
  `);
  check('权重滑块改变综合最优排序', weightOk.changed, `${weightOk.cheapFirst}  ⇄  ${weightOk.timeFirst}`);

  /* ---- 行程详情：打开 + Esc 关闭 ---- */
  // 等待列表稳定（避免刚好撞上 Service Worker 接管导致的短暂空白）
  const hasItem = await waitFor(async () => cdp.eval(`return !!document.querySelector('.item')`));
  check('列表项可用', Boolean(hasItem));

  const detail = await cdp.eval(`
    document.querySelector('.item').click();
    await new Promise(r => setTimeout(r, 150));
    const opened = !document.getElementById('detailCard').hidden;
    const hasSvg = !!document.querySelector('#detailTimeline svg');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const closed = document.getElementById('detailCard').hidden;
    return { opened, hasSvg, closed };
  `);
  check('点击方案展开行程详情', detail.opened && detail.hasSvg);
  check('Esc 能关闭行程详情', detail.closed);

  /* ---- 散点图真的画了东西 ---- */
  const chartPainted = await cdp.eval(`
    const c = document.getElementById('chartCanvas');
    if (!c) return false;
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, Math.min(c.width, 300), Math.min(c.height, 200)).data;
    let colored = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 0) colored++;
    }
    return colored > 100;
  `);
  check('散点图已绘制', chartPainted);

  /* ---- 排序切换 ---- */
  const sortOk = await cdp.eval(`
    const firstBefore = document.querySelector('.item .train-code').textContent;
    document.querySelector('[data-sort="price"]').click();
    await new Promise(r => setTimeout(r, 150));
    const firstPrice = document.querySelector('.item .price').textContent;
    document.querySelector('[data-sort="score"]').click();
    await new Promise(r => setTimeout(r, 150));
    return { firstBefore, firstPrice };
  `);
  check('排序切换生效', /¥/.test(sortOk.firstPrice), JSON.stringify(sortOk));

  /* ---- 历史记录已写入 ---- */
  const history = await cdp.eval(`
    const raw = localStorage.getItem('kunle.history.v2');
    const list = raw ? JSON.parse(raw) : [];
    return { count: list.length, visible: !document.getElementById('historyCard').hidden };
  `);
  check('历史记录已保存并展示', history.count > 0 && history.visible, JSON.stringify(history));

  /* ---- 设置持久化 ---- */
  const persist = await cdp.eval(`
    const s = document.getElementById('weightInput');
    s.value = '75';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const saved = JSON.parse(localStorage.getItem('kunle.settings.v2') || '{}');
    return saved.weight;
  `);
  check('权重写入本地设置', persist === 75, `weight=${persist}`);

  /* ---- 主题切换 ---- */
  const theme = await cdp.eval(`
    const btn = document.getElementById('themeBtn');
    const before = document.documentElement.getAttribute('data-theme');
    btn.click();
    await new Promise(r => setTimeout(r, 120));
    const after = document.documentElement.getAttribute('data-theme');
    return { before, after, changed: before !== after };
  `);
  check('主题切换生效', theme.changed, `${theme.before} → ${theme.after}`);

  /* ---- CSV 往返 ---- */
  const csv = await cdp.eval(`
    const rows = [{code:'G1', fromStation:'北京南', toStation:'上海虹桥', depart:'06:30', arrive:'11:24', durationMin:294, price:598, seatText:'二等座 有', group:'direct'}];
    const text = KunleParse.toCSV(rows);
    const back = KunleParse.fromCSV(text);
    return { ok: back.length === 1 && back[0].code === 'G1' && back[0].price === 598 };
  `);
  check('CSV 导出导入往返一致', csv.ok);

  /* ---- 报告生成 ---- */
  const report = await cdp.eval(`
    const md = KunleReport.markdown([{code:'G1',price:598,durationMin:294,score:0.5,transferCount:0,legs:[{code:'G1',from:'北京南',to:'上海虹桥',depart:'06:30',arrive:'11:24',durationMin:294,price:598}],fromStation:'北京南',toStation:'上海虹桥',depart:'06:30',arrive:'11:24'}], {});
    return { hasTitle: md.includes('车票最优方案报告'), len: md.length };
  `);
  check('报告可生成', report.hasTitle && report.len > 200, `长度 ${report.len}`);

  /* ---- 数据校验 ---- */
  const validate = await cdp.eval(`
    const rows = [{code:'', fromStation:'北京南', toStation:'上海虹桥', depart:'06:30', arrive:'11:24', durationMin:294, price:598, group:'direct'}];
    const r = KunleValidate.validateRows(rows, {});
    return { errors: r.summary.error, blocking: r.hasBlocking };
  `);
  check('数据校验能发现缺车次', validate.errors >= 1 && validate.blocking, JSON.stringify(validate));

  /* ---- 空数据状态 ---- */
  const empty = await cdp.eval(`
    document.getElementById('clearBtn').click();
    await new Promise(r => setTimeout(r, 150));
    const hintVisible = !document.getElementById('emptyHint').hidden;
    const resultsHidden = document.getElementById('results').hidden;
    const detailHidden = document.getElementById('detailCard').hidden;
    return { hintVisible, resultsHidden, detailHidden };
  `);
  check('清空后回到空状态', empty.hintVisible && empty.resultsHidden && empty.detailHidden, JSON.stringify(empty));

  } catch (err) {
    check('检查流程未中断', false, String(err && err.message ? err.message : err));
  }

  /* ---- 控制台错误 ---- */
  const errors = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || 'exception');

  const consoleErrors = cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => e.params.args.map((a) => a.value ?? a.description).join(' '));

  check('无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  /* ---- Service Worker 策略（避免新旧版本混用） ---- */
  // 在浏览器上下文里取，避免 Node 的 fetch 不走系统代理导致误报
  const sw = await cdp.eval(`
    const r = await fetch('sw.js', { cache: 'no-store' });
    return await r.text();
  `);
  check(
    'Service Worker 已升级且改为网络优先',
    /kunle-v5/.test(sw) && /networkFirst|NETWORK_FIRST/.test(sw),
    sw.match(/kunle-v\d+/)?.[0] || '未找到版本号'
  );

  /* ---- 版本自检：页面构建号必须与 version.json 一致 ---- */
  const ver = await cdp.eval(`
    const tag = document.getElementById('versionTag');
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const j = await r.json();
    return { page: (tag ? tag.textContent : '').replace(/^v/, ''), remote: j.version };
  `);
  check('页面版本与 version.json 一致', Boolean(ver.page) && ver.page === ver.remote,
    `页面 v${ver.page} / 线上 v${ver.remote}`);

  /* ---- 一键清缓存页可用 ---- */
  const reset = await cdp.eval(`
    const r = await fetch('reset.html', { cache: 'no-store' });
    const t = await r.text();
    return { ok: r.ok, unregister: t.includes('getRegistrations'), clear: t.includes('caches.delete') };
  `);
  check('reset.html 可访问且会注销 SW / 清缓存', reset.ok && reset.unregister && reset.clear);

  /* ---- 头部强制更新按钮 ---- */
  const hasResetBtn = await cdp.eval(`return !!document.getElementById('hardResetBtn')`);
  check('头部提供「清除缓存并更新」按钮', Boolean(hasResetBtn));

  /* ---- 收尾 ---- */
  ws.close();  chrome.kill();
  await sleep(400);
  await rm(userDir, { recursive: true, force: true }).catch(() => {});

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(' - ' + f.name + (f.detail ? '：' + f.detail : '')));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('QA 脚本异常：', err);
  process.exit(1);
});
