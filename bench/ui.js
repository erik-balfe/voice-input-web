// UI + theme + update test. Usage: node ui.js <webdir> <outdir>
const { chromium } = require('/workspace/pwtest/node_modules/playwright-core');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const SRC = process.argv[2], OUT = process.argv[3] || __dirname + '/shots'; fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gvweb-')); fs.cpSync(SRC, TMP, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  let p = path.join(TMP, req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream', 'cache-control': 'max-age=600' }); res.end(d); }); // like GitHub Pages
});
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 86400 * 400 })}.x`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await new Promise(r => srv.listen(8124, r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  async function open(opts, saved) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'], ...opts });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto('http://localhost:8124/'); await page.waitForTimeout(300);
    await page.evaluate(async ({ JWT, saved }) => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('grokvoice', 1); r.onsuccess = () => res(r.result); r.onerror = rej; });
      await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); const s = t.objectStore('kv'); s.put({ access_token: JWT, refresh_token: 'r', id_token: JWT }, 'tokens'); s.put(saved || { cleanup: true }, 'settings'); t.oncomplete = res; });
    }, { JWT, saved });
    await page.reload(); await page.waitForTimeout(500);
    return { ctx, page, errs };
  }
  const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const tc = (page) => page.evaluate(() => [...document.querySelectorAll('meta[name=theme-color]')].map(m => m.content + (m.media ? '@' + (m.media.includes('dark') ? 'dark' : 'light') : '')).join(','));
  // 1) Theme: system light / system dark / forced
  for (const scheme of ['light', 'dark']) {
    const { ctx, page, errs } = await open({ colorScheme: scheme, serviceWorkers: 'block' });
    console.log(`system=${scheme}: body bg ${await bg(page)}; theme-color ${await tc(page)}; errors ${errs.length}`);
    await page.screenshot({ path: `${OUT}/idle-${scheme}.png` });
    // recording state (fake mic) + timer
    await page.click('#rec'); await page.waitForTimeout(2300);
    const st = await page.evaluate(() => ({ timer: document.getElementById('timer').textContent, on: document.getElementById('timer').classList.contains('on'), cls: document.getElementById('rec').className, label: document.getElementById('rec').getAttribute('aria-label'), halo: document.getElementById('ring').style.transform + ' ' + document.getElementById('ring').style.opacity, box: (() => { const r = document.getElementById('rec').getBoundingClientRect(); return [r.width, r.height]; })() }));
    console.log('  recording:', JSON.stringify(st));
    await page.screenshot({ path: `${OUT}/recording-${scheme}.png` });
    await page.click('#cancel'); await page.waitForTimeout(400);
    await page.click('[data-tab=settings]'); await page.waitForTimeout(200);
    if (scheme === 'light') {
      await page.click('[data-theme-mode=dark]'); await page.waitForTimeout(150);
      console.log('  forced dark on light system: bg', await bg(page), 'dataset', await page.evaluate(() => document.documentElement.dataset.theme), 'theme-color', await tc(page), 'stored', await page.evaluate(() => localStorage.getItem('gv-theme')));
      await page.reload(); await page.waitForTimeout(400);
      console.log('  after reload: bg', await bg(page), 'segment checked', await page.evaluate(() => document.querySelector('[aria-checked=true]')?.dataset.themeMode));
      await page.click('[data-tab=settings]'); await page.click('[data-theme-mode=system]'); await page.waitForTimeout(150);
      console.log('  back to system: bg', await bg(page), 'stored', await page.evaluate(() => localStorage.getItem('gv-theme')), 'theme-color', await tc(page));
    } else {
      await page.click('[data-theme-mode=light]'); await page.waitForTimeout(150);
      console.log('  forced light on dark system: bg', await bg(page));
    }
    await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
    await page.screenshot({ path: `${OUT}/settings-${scheme}.png`, fullPage: true });
    await ctx.close();
  }
  // processing state screenshot: slow STT via route
  { const { ctx, page } = await open({ colorScheme: 'light', serviceWorkers: 'block' });
    await page.route('https://api.x.ai/**', async (route) => { await sleep(3000); route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ text: 'Пробный текст диктовки' }) }); });
    await page.click('#rec'); await page.waitForTimeout(2200); await page.click('#rec'); await page.waitForTimeout(500);
    console.log('processing:', await page.evaluate(() => document.getElementById('rec').className + ' | ' + document.getElementById('status').textContent));
    await page.screenshot({ path: `${OUT}/processing-light.png` }); await ctx.close(); }
  // 2) Update flow with a real service worker and a 10-min HTTP cache on the server
  { const { ctx, page } = await open({ colorScheme: 'light' });
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 8000 }).catch(() => {});
    const v1 = await page.evaluate(() => document.getElementById('app-version').textContent);
    console.log('update: loaded', v1, 'controlled by SW:', await page.evaluate(() => !!navigator.serviceWorker.controller));
    const T0=Date.now(); page.on('request', r => console.log('   [req]', Date.now()-T0, r.url().slice(22,60))); page.on('framenavigated', f => f === page.mainFrame() && console.log('   [nav]', Date.now()-T0)); page.on('console', m=>console.log('   [con]',m.text().slice(0,100)));
    // publish a new version
    const app = fs.readFileSync(TMP + '/app.js', 'utf8').replace(/APP_VERSION = "([^"]+)"/, 'APP_VERSION = "9999-test.1"');
    fs.writeFileSync(TMP + '/app.js', app);
    fs.writeFileSync(TMP + '/sw.js', fs.readFileSync(TMP + '/sw.js', 'utf8').replace(/const CACHE = "[^"]+"/, 'const CACHE = "grokvoice-9999-test.1"'));
    const t0 = Date.now();
    await page.waitForFunction(() => document.getElementById('app-version')?.textContent.startsWith('9999'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    console.log('  automatic: version', await page.evaluate(() => document.getElementById('app-version').textContent), 'after', Date.now() - t0, 'ms; controller', await page.evaluate(() => !!navigator.serviceWorker.controller));
    // busy: no reload during recording; banner instead
    fs.writeFileSync(TMP + '/app.js', fs.readFileSync(TMP + '/app.js', 'utf8').replace(/APP_VERSION = "([^"]+)"/, 'APP_VERSION = "9999-test.2"'));
    fs.writeFileSync(TMP + '/sw.js', fs.readFileSync(TMP + '/sw.js', 'utf8').replace(/const CACHE = "[^"]+"/, 'const CACHE = "grokvoice-9999-test.2"'));
    await page.click('[data-tab=dictate]'); await page.click('#rec'); await page.waitForTimeout(800);
    await page.evaluate(() => document.querySelector('#check-update').click());
    await sleep(1500);
    console.log('  while recording: version', await page.evaluate(() => document.getElementById('app-version').textContent), 'banner:', await page.evaluate(() => document.getElementById('update-banner').classList.contains('hidden') ? 'hidden' : document.getElementById('update-banner-text').textContent));
    await page.screenshot({ path: `${OUT}/update-banner.png` });
    await page.click('#cancel');
    await page.waitForFunction(() => document.getElementById('app-version').textContent === '9999-test.2', null, { timeout: 15000 }).catch(() => {});
    console.log('  after recording ended: version', await page.evaluate(() => document.getElementById('app-version').textContent));
    await ctx.close(); }
  await browser.close(); srv.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
