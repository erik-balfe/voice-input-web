// Browser e2e with a mock api.x.ai (HTTPS, real chunked SSE). Usage: node e2e.js <webdir> <label> [scenarios...]
const { chromium } = require('/workspace/pwtest/node_modules/playwright-core');
const https = require('https'), http = require('http'), fs = require('fs'), path = require('path');
const WEB = process.argv[2], LABEL = process.argv[3] || 'run';
const RAW = "Э, слушай, короче, я сегодня буду, ну, около шести, нет, около семи вечера. Так что это самое, начинайте без меня.";
const CLEAN = "Я сегодня буду около семи вечера. Так что начинайте без меня.";
const sse = fs.readFileSync(__dirname + '/sse_sample.txt', 'utf8');
const sseEvents = sse.split('\n\n').filter(Boolean);
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// scenario knobs (mutated per test)
let S = {};
const reqLog = [];
const mock = https.createServer({ key: fs.readFileSync(__dirname + '/mock.key'), cert: fs.readFileSync(__dirname + '/mock.crt') }, async (req, res) => {
  const t = Date.now();
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
  const url = req.url;
  if (url.startsWith('/v1/models')) { res.writeHead(401, cors); return res.end('{}'); }
  if (url.startsWith('/v1/stt')) {
    reqLog.push('stt');
    const n = reqLog.filter(x => x === 'stt').length;
    await sleep(S.stt ?? 300);
    if (S.sttFail && n <= S.sttFail) { res.writeHead(S.sttStatus || 503, cors); return res.end('{"error":"x"}'); }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ text: S.sttEmpty ? '' : RAW }));
  }
  if (url.startsWith('/v1/responses')) {
    const p = JSON.parse(body.toString());
    reqLog.push('rf:' + p.model + (p.reasoning ? ':' + p.reasoning.effort : '') + (p.stream ? ':stream' : '') + (JSON.stringify(p.input).includes('<dictation>') ? ':wrap' : ''));
    if (S.rejectModels && S.rejectModels.includes(p.model)) { res.writeHead(400, { ...cors, 'content-type': 'application/json' }); return res.end('{"error":"model not available"}'); }
    const fast = /non-reasoning|4\.3/.test(p.model);
    await sleep(S.rf ?? (fast ? 350 : 3500));
    if (S.rf500) { res.writeHead(500, cors); return res.end('{"error":"boom"}'); }
    if (p.stream) {
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
      for (const ev of sseEvents) { res.write(ev + '\n\n'); await sleep(/delta/.test(ev) ? 25 : 0); }
      return res.end();
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: CLEAN }] }], usage: {} }));
  }
  res.writeHead(404, cors); res.end();
});
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const stat = http.createServer((req, res) => {
  let p = path.join(WEB, req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 86400 * 400, email: 'test@example.com' })}.x`;
const OLD_PROMPT = fs.readFileSync(__dirname + '/prompt_cur.txt', 'utf8');
(async () => {
  await new Promise(r => mock.listen(9443, r)); await new Promise(r => stat.listen(8123, r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors', '--host-resolver-rules=MAP api.x.ai 127.0.0.1:9443'] });
  const results = {};
  async function newPage(saved) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, permissions: ['microphone', 'clipboard-read', 'clipboard-write'], serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push('PAGEERR ' + e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto('http://localhost:8123/');
    await page.waitForTimeout(400);
    await page.evaluate(async ({ saved, JWT }) => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('grokvoice', 1); r.onsuccess = () => res(r.result); r.onerror = rej; });
      await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); const s = t.objectStore('kv'); s.put({ access_token: JWT, refresh_token: 'r', id_token: JWT }, 'tokens'); s.put(saved, 'settings'); t.oncomplete = res; });
    }, { saved, JWT });
    await page.reload(); await page.waitForTimeout(500);
    return { ctx, page, errs };
  }
  // one dictation: click rec, speak 2 s, click stop; resolve timings
  async function dictate(page, waitMs = 15000, probeAt = 0) {
    await page.evaluate(() => { document.getElementById('result').value = ''; }); await page.click('#rec'); await page.waitForTimeout(2200);
    const t0 = Date.now(); await page.click('#rec');
    const marks = {};
    const start = Date.now();
    if (probeAt) setTimeout(async () => { marks.clipAtProbe = await page.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR ' + e.message)); marks.valAtProbe = await page.evaluate(() => document.getElementById('result').value); }, probeAt);
    while (Date.now() - start < waitMs) {
      const st = await page.evaluate(() => ({ status: document.getElementById('status').textContent, val: document.getElementById('result').value, cls: document.getElementById('result').className }));
      if (st.val && marks.firstText == null) marks.firstText = Date.now() - t0;
      if (st.val === CLEAN && marks.clean == null) marks.clean = Date.now() - t0;
      if (/Готово|Ошибка/.test(st.status) && marks.done == null) { marks.done = Date.now() - t0; marks.status = st.status; }
      if (marks.done != null && (marks.clean != null || /Ошибка/.test(st.status) || Date.now() - t0 > marks.done + 800)) break;
      await sleep(30);
    }
    marks.clip = await page.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR ' + e.message));
    marks.result = await page.evaluate(() => document.getElementById('result').value);
    return marks;
  }
  const oldSaved = { language: 'ru', cleanup: true, autocopy: true, cleanupModel: 'grok-4.7', cleanupEffort: 'low', cleanupPrompt: OLD_PROMPT };
  const only = process.argv.slice(4);
  const want = (n) => !only.length || only.includes(n);
  const isNew = fs.existsSync(WEB + '/metrics.js');
  const fmt = (m) => `firstText ${m.firstText}ms, cleanText ${m.clean}ms, statusDone ${m.done}ms, clip=${JSON.stringify((m.clip || '').slice(0, 40))}`;

  if (want('baseline')) {
    S = {}; reqLog.length = 0;
    const { page, errs, ctx } = await newPage(oldSaved);
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(await dictate(page));
    console.log(`[${LABEL}] default settings (migrated user), 3 runs; requests=${JSON.stringify(reqLog)}`);
    rows.forEach((m, i) => console.log(`   run${i + 1}: ${fmt(m)}`));
    console.log('   errors:', errs.length ? errs : 'none');
    if (isNew) {
      console.log('   settings after load:', JSON.stringify(await page.evaluate(() => document.getElementById('cleanup-preset').value)));
      const tm = await page.evaluate(async () => { const r = indexedDB.open('grokvoice', 1); const db = await new Promise(res => r.onsuccess = () => res(r.result)); return new Promise(res => { const q = db.transaction('kv').objectStore('kv').get('timings'); q.onsuccess = () => res(q.result); }); });
      console.log('   stored timings:', tm.length, 'sample:', JSON.stringify(tm[tm.length - 1]));
      const leak = JSON.stringify(tm).match(/слушай|короче|семи|вечера/i); console.log('   dictated text found in timings store:', !!leak);
      await page.click('[data-tab=settings]'); await page.waitForTimeout(200);
      await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
      await page.screenshot({ path: __dirname + `/shot-diag-${LABEL}.png`, fullPage: true });
      await page.click('[data-tab=dictate]');
    }
    await ctx.close();
  }
  if (isNew && want('smart')) {
    S = {}; reqLog.length = 0;
    const { page, ctx } = await newPage({ ...oldSaved, preset: 'smart' });
    const m = await dictate(page);
    console.log(`[${LABEL}] smart preset (4.7 low, slow 3.5 s): ${fmt(m)}; requests=${JSON.stringify(reqLog)}`);
    await ctx.close();
  }
  if (isNew && want('budget')) {
    S = { rf: 5000 }; reqLog.length = 0;  // refine slower than the 2 s budget
    const { page, ctx } = await newPage({ ...oldSaved, preset: 'fast', cleanupModel: 'grok-4.20-0309-non-reasoning', cleanupEffort: '', cleanupPrompt: 'x', refineBudgetMs: 2000 });
    const m = await dictate(page, 20000, 3200);
    console.log(`[${LABEL}] over-budget refine (5 s, budget 2 s): at t=3.2s clipboard=${JSON.stringify((m.clipAtProbe||'').slice(0,30))} textarea=${JSON.stringify((m.valAtProbe||'').slice(0,30))}; ${fmt(m)}; final textarea=${JSON.stringify(m.result.slice(0, 50))} status=${JSON.stringify(m.status)}`);
    await ctx.close();
  }
  if (isNew && want('fallback')) {
    S = { rejectModels: ['grok-4.20-0309-non-reasoning'] }; reqLog.length = 0;
    const { page, ctx } = await newPage({ ...oldSaved, preset: 'fast', cleanupModel: 'grok-4.20-0309-non-reasoning', cleanupEffort: '', cleanupPrompt: 'x' });
    const m = await dictate(page);
    console.log(`[${LABEL}] model rejected (400) → fallback chain: ${fmt(m)}; requests=${JSON.stringify(reqLog)}; meta=${JSON.stringify(await page.evaluate(() => document.getElementById('result-meta').textContent))}`);
    await ctx.close();
  }
  if (isNew && want('retry')) {
    S = { sttFail: 1, sttStatus: 503 }; reqLog.length = 0;
    let { page, ctx } = await newPage({ ...oldSaved, preset: 'fast', cleanupModel: 'grok-4.20-0309-non-reasoning', cleanupEffort: '', cleanupPrompt: 'x' });
    let m = await dictate(page);
    console.log(`[${LABEL}] STT 503 once → retry: ${fmt(m)}; requests=${JSON.stringify(reqLog)}`); await ctx.close();
    S = { sttEmpty: true }; reqLog.length = 0;
    ({ page, ctx } = await newPage({ ...oldSaved, preset: 'fast', cleanupModel: 'grok-4.20-0309-non-reasoning', cleanupEffort: '', cleanupPrompt: 'x' }));
    m = await dictate(page);
    console.log(`[${LABEL}] STT empty (silence): ${fmt(m)}; status=${JSON.stringify(m.status)}; requests=${JSON.stringify(reqLog)}`); await ctx.close();
  }
  if (isNew && want('skip')) {
    S = {}; reqLog.length = 0;
    const { page, ctx } = await newPage({ ...oldSaved, preset: 'fast', cleanupModel: 'grok-4.20-0309-non-reasoning', cleanupEffort: '', cleanupPrompt: 'x', skipRefineWords: 40 });
    const m = await dictate(page);
    console.log(`[${LABEL}] skip refine (<40 words): ${fmt(m)}; requests=${JSON.stringify(reqLog)}`); await ctx.close();
  }
  if (isNew && want('export')) {
    S = {}; reqLog.length = 0;
    const { page, ctx } = await newPage({ ...oldSaved });
    for (let i = 0; i < 2; i++) await dictate(page);
    await page.click('[data-tab=settings]'); await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
    console.log('[' + LABEL + '] export info:', await page.textContent('#export-info'));
    for (const withAudio of [false, true]) {
      await page.evaluate((v) => { document.getElementById('export-audio').checked = v; }, withAudio);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-download')]);
      const p = await dl.path(); const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const h = j.history[j.history.length - 1];
      console.log('[' + LABEL + '] export audio=' + withAudio + ': file', dl.suggestedFilename(), fs.statSync(p).size + 'B', 'entries', j.history.length, 'timings', j.timings.length,
        'raw ok:', h.raw === RAW, 'text ok:', h.text === CLEAN, 'model', h.model, 'has audio:', !!h.audio, h.audio ? 'bytes ' + h.audio.bytes + ' b64len ' + h.audio.base64.length + ' decoded ' + Buffer.from(h.audio.base64, 'base64').length : '',
        'entry.timing keys:', Object.keys(h.timing || {}).slice(0, 6).join(','));
      console.log('   msg:', await page.textContent('#export-msg'));
    }
    const sent = reqLog.filter(x => !/^stt|^rf/.test(x)); console.log('[' + LABEL + '] unexpected network requests during export:', sent.length);
    await ctx.close();
  }
  if (isNew && want('presets')) {
    for (const pr of ['fast', 'fast43', 'smart']) {
      S = { rf: 300 }; reqLog.length = 0;
      const { page, ctx } = await newPage({ ...oldSaved });
      await page.click('[data-tab=settings]'); await page.selectOption('#cleanup-preset', pr); await page.click('[data-tab=dictate]');
      const m = await dictate(page);
      const st = await page.evaluate(async () => { const r = indexedDB.open('grokvoice', 1); const db = await new Promise(res => r.onsuccess = () => res(r.result)); return new Promise(res => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => res({ preset: q.result.preset, model: q.result.cleanupModel, effort: q.result.cleanupEffort, promptStart: q.result.cleanupPrompt.slice(0, 30) }); }); });
      console.log('[' + LABEL + '] preset ' + pr + ': saved ' + JSON.stringify(st) + '; requests=' + JSON.stringify(reqLog) + '; clean ok: ' + (m.result === CLEAN));
      await ctx.close();
    }
  }
  if (isNew && want('migrate')) {
    const cases = {
      'no preset, stock': { ...oldSaved },
      'preset classic': { ...oldSaved, preset: 'classic' },
      'no preset, other model': { ...oldSaved, cleanupModel: 'grok-4.3', cleanupEffort: 'none' },
      'no preset, edited prompt': { ...oldSaved, cleanupPrompt: 'my own prompt' },
      'classic, edited effort': { ...oldSaved, preset: 'classic', cleanupEffort: 'high' },
      'custom kept': { ...oldSaved, preset: 'custom', cleanupModel: 'grok-4.5', cleanupEffort: 'low', cleanupPrompt: 'mine' },
      'smart kept': { ...oldSaved, preset: 'smart', cleanupModel: 'grok-4.7', cleanupEffort: 'low' },
      'fast43 kept': { ...oldSaved, preset: 'fast43', cleanupModel: 'grok-4.3', cleanupEffort: 'none' },
    };
    for (const [name, saved] of Object.entries(cases)) {
      const { page, ctx } = await newPage(saved);
      const st = await page.evaluate(async () => { const r = indexedDB.open('grokvoice', 1); const db = await new Promise(res => r.onsuccess = () => res(r.result)); return new Promise(res => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => res({ preset: q.result.preset, model: q.result.cleanupModel, effort: q.result.cleanupEffort, strict: /<dictation>/.test(q.result.cleanupPrompt), sel: document.getElementById('cleanup-preset').value, opts: [...document.getElementById('cleanup-preset').options].map(o => o.textContent).join(' | ') }); }); });
      console.log('[' + LABEL + '] migrate ' + name + ': ' + JSON.stringify({ ...st, opts: undefined }));
      if (name === 'no preset, stock') console.log('   options: ' + st.opts);
      await ctx.close();
    }
  }
  await browser.close(); mock.close(); stat.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
