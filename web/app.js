import { CONFIG } from "./config.js";
import { kv, history } from "./db.js";
import * as auth from "./auth.js";
import { transcribe, cleanup, warmup, HttpError } from "./grok.js";
import { Trace, timings, summarize } from "./metrics.js";
import { exportFile, shareFile, downloadFile, estimate } from "./export.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const AUTOSTART = params.get("autostart") === "1";
const MAX_TAKE_SEC = 300;
const MIN_TAKE_SEC = 0.5;
const APP_VERSION = "2026-10-18.2";


const settings = {
  language: "ru",
  cleanup: false,
  autocopy: true,
  preset: CONFIG.defaultPreset, // fast | smart | custom
  cleanupModel: CONFIG.presets[CONFIG.defaultPreset].model,
  cleanupEffort: CONFIG.presets[CONFIG.defaultPreset].effort, // "" = model default (not sent)
  cleanupPrompt: CONFIG.carefulCleanupPrompt,
  skipRefineWords: 0, // 0 = always refine; N = skip refine for dictations shorter than N words
  refineBudgetMs: CONFIG.refineBudgetMs,
  timings: true, // numeric timings only, never dictated text
  presetNote: false, // one-time notice after migration to the fast preset
};
let resultEdited = false;

let state = "idle"; // idle | recording | processing
let rec = null; // { stream, recorder, chunks, mime, startedAt, ctx, raf, timer }

// ---------- settings ----------
async function loadSettings() {
  const saved = (await kv.get("settings")) || {};
  Object.assign(settings, saved);
  // Migrate: users who never changed the old default (grok-4.7 low + careful prompt) get the «classic» preset: behaviour is unchanged.
  let migrated = false;
  if (!saved.preset) {
    const oldPrompts = [CONFIG.carefulCleanupPrompt, ...CONFIG.legacyCleanupPrompts];
    const untouched = (!saved.cleanupModel || saved.cleanupModel === "grok-4.7" || CONFIG.legacyCleanupModels.includes(saved.cleanupModel))
      && (!saved.cleanupPrompt || oldPrompts.includes(saved.cleanupPrompt.trim()));
    if (untouched) { applyPreset(CONFIG.defaultPreset); settings.presetNote = false; }
    else settings.preset = "custom";
    migrated = true;
  }
  if (migrated) await saveSettings();
  $("language").value = settings.language;
  $("cleanup").checked = settings.cleanup;
  $("cleanup-quick").checked = settings.cleanup;
  $("autocopy").checked = settings.autocopy;
  $("cleanup-preset").value = settings.preset;
  $("skip-words").value = settings.skipRefineWords;
  $("refine-budget").value = Math.round(settings.refineBudgetMs / 1000);
  $("timings-on").checked = settings.timings !== false;
  $("preset-note").classList.toggle("hidden", !settings.presetNote);
  renderModelControls();
  $("cleanup-prompt").value = settings.cleanupPrompt;
  $("use-apikey").checked = ((await kv.get("authMode")) || "oauth") === "apikey";
  $("apikey").value = (await kv.get("apiKey")) || "";
}
const saveSettings = () => kv.set("settings", { ...settings });

function applyPreset(name) {
  const p = CONFIG.presets[name];
  if (!p) { settings.preset = "custom"; return; }
  settings.preset = name;
  settings.cleanupModel = p.model;
  settings.cleanupEffort = p.effort;
  settings.cleanupPrompt = p.prompt === "strict" ? CONFIG.strictCleanupPrompt : CONFIG.carefulCleanupPrompt;
}
const markCustom = () => { settings.preset = "custom"; $("cleanup-preset").value = "custom"; };

function bindSettings() {
  $("language").onchange = (e) => { settings.language = e.target.value; saveSettings(); };
  const setCleanup = (v) => { settings.cleanup = v; $("cleanup").checked = v; $("cleanup-quick").checked = v; saveSettings(); };
  $("cleanup").onchange = (e) => setCleanup(e.target.checked);
  $("cleanup-quick").onchange = (e) => setCleanup(e.target.checked);
  $("autocopy").onchange = (e) => { settings.autocopy = e.target.checked; saveSettings(); };
  $("cleanup-preset").onchange = (e) => {
    if (e.target.value === "custom") { settings.preset = "custom"; saveSettings(); return; }
    applyPreset(e.target.value); showCustom(false);
    $("cleanup-prompt").value = settings.cleanupPrompt; renderModelControls(); saveSettings();
  };
  $("preset-note-ok").onclick = () => { settings.presetNote = false; $("preset-note").classList.add("hidden"); saveSettings(); };
  $("skip-words").onchange = (e) => { settings.skipRefineWords = Math.max(0, Math.min(50, parseInt(e.target.value, 10) || 0)); e.target.value = settings.skipRefineWords; saveSettings(); };
  $("refine-budget").onchange = (e) => { const v = Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 6)); e.target.value = v; settings.refineBudgetMs = v * 1000; saveSettings(); };
  $("timings-on").onchange = (e) => { settings.timings = e.target.checked; saveSettings(); };
  $("diag-copy").onclick = async () => { const list = await timings.list(); const ok = await copyText(JSON.stringify({ app: APP_VERSION, runs: list }, null, 1)); $("diag-msg").textContent = ok ? `Скопировано: ${list.length} замеров` : "Не удалось скопировать"; };
  $("export-audio").onchange = refreshExportEstimate;
  const doExport = async (how) => {
    const msg = $("export-msg"); msg.textContent = "Готовлю файл…";
    try {
      const r = await exportFile({ audio: $("export-audio").checked, appVersion: APP_VERSION });
      if (!r.count) { msg.textContent = "История пуста — экспортировать нечего"; return; }
      const mb = r.bytes > 1048576 ? (r.bytes / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(r.bytes / 1024)) + " КБ";
      if (how === "share") {
        try { if (await shareFile(r.file, r.count)) { msg.textContent = `Отправлено в «Поделиться»: ${r.count} записей, ${mb}`; return; } }
        catch (e) { if (e.name === "AbortError") { msg.textContent = "Отменено"; return; } throw e; }
        msg.textContent = "Браузер не умеет делиться файлами — скачиваю…";
      }
      downloadFile(r.file);
      msg.textContent = `Файл ${r.name} (${r.count} записей, ${mb}) скачан — найдите его в «Файлах»/загрузках и отправьте боту в чат`;
    } catch (e) { msg.textContent = `Ошибка экспорта: ${e.message || e}`; }
  };
  $("export-share").onclick = () => doExport("share");
  $("export-download").onclick = () => doExport("download");
  $("diag-clear").onclick = async () => { await timings.clear(); renderDiagnostics(); };
  $("cleanup-model-select").onchange = (e) => {
    markCustom();
    const v = e.target.value;
    if (v === "__custom") { settings.cleanupModel = $("cleanup-model-custom").value.trim() || settings.cleanupModel; showCustom(true); }
    else { settings.cleanupModel = v; const m = modelInfo(v); settings.cleanupEffort = m?.efforts ? m.defaultEffort : ""; }
    saveSettings(); renderModelControls();
  };
  $("cleanup-model-custom").onchange = (e) => { const v = e.target.value.trim(); if (v) { markCustom(); settings.cleanupModel = v; saveSettings(); renderModelControls(); } };
  $("cleanup-effort").onchange = (e) => { markCustom(); settings.cleanupEffort = e.target.value; saveSettings(); };
  $("cleanup-prompt").onchange = (e) => { markCustom(); settings.cleanupPrompt = e.target.value.trim() || CONFIG.strictCleanupPrompt; saveSettings(); };
  $("reset-prompt").onclick = () => {
    applyPreset(CONFIG.defaultPreset); showCustom(false);
    $("cleanup-preset").value = settings.preset;
    renderModelControls(); $("cleanup-prompt").value = settings.cleanupPrompt; saveSettings();
  };
  $("use-apikey").onchange = async (e) => { await kv.set("authMode", e.target.checked ? "apikey" : "oauth"); renderAccount(); };
  $("apikey").onchange = async (e) => { const v = e.target.value.trim(); v ? await kv.set("apiKey", v) : await kv.del("apiKey"); renderAccount(); };
}

const modelInfo = (id) => CONFIG.cleanupModels.find((m) => m.id === id);
let customShown = false;
function showCustom(v) { customShown = v; $("custom-model-wrap").classList.toggle("hidden", !v); }

function renderModelControls() {
  const sel = $("cleanup-model-select");
  const known = modelInfo(settings.cleanupModel);
  sel.innerHTML = "";
  for (const m of CONFIG.cleanupModels) sel.add(new Option(m.label, m.id));
  sel.add(new Option("Другая модель…", "__custom"));
  sel.value = known && !customShown ? known.id : "__custom";
  showCustom(!known || customShown);
  if (!known) $("cleanup-model-custom").value = settings.cleanupModel;
  const eff = $("cleanup-effort");
  eff.innerHTML = "";
  eff.add(new Option("по умолчанию модели", ""));
  const names = { none: "без рассуждения (быстрее всего)", low: "низкая (быстро)", medium: "средняя", high: "высокая", xhigh: "максимальная" };
  const list = known ? known.efforts || [] : ["none", "low", "medium", "high", "xhigh"];
  for (const e of list) eff.add(new Option(names[e] || e, e));
  eff.disabled = !!known && !known.efforts;
  if (known && (!known.efforts || !known.efforts.includes(settings.cleanupEffort))) settings.cleanupEffort = known.efforts ? known.defaultEffort : "";
  eff.value = settings.cleanupEffort || "";
}

function promptMode() {
  if (settings.cleanupPrompt === CONFIG.strictCleanupPrompt) return CONFIG.presets[settings.preset]?.shots ? "strict+examples" : "strict";
  return settings.cleanupPrompt === CONFIG.carefulCleanupPrompt ? "careful" : "custom";
}

/** The strict prompt comes with its wrapper (+ worked examples in «smart»); a hand-edited prompt is sent as is. */
function promptPack() {
  if (settings.cleanupPrompt !== CONFIG.strictCleanupPrompt) return undefined;
  return { wrap: true, shots: CONFIG.presets[settings.preset]?.shots ? CONFIG.strictShots : [] };
}

/** Cleanup with automatic fallback when the chosen model is rejected (retired / not in the OAuth plan). */
async function runCleanup(raw, trace, onDelta) {
  const first = { model: settings.cleanupModel, effort: settings.cleanupEffort || "" };
  const tries = [first, ...CONFIG.fallbackChain.filter((f) => f.model !== first.model)];
  let firstErr;
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    trace.m.model = t.model; trace.m.effort = t.effort || "";
    try {
      const text = await cleanup(raw, t.model, settings.cleanupPrompt, t.effort || undefined, { trace, onDelta, pack: promptPack() });
      return { text, model: t.model, effort: t.effort || "", note: i ? `Модель ${first.model} отклонена (${String(firstErr.message).slice(0, 120)}), использована ${t.model}` : "" };
    } catch (e) {
      firstErr = firstErr || e;
      trace.note(`rf model ${t.model}: ${e.status || e.name}`);
      if (!(e instanceof HttpError) || ![400, 403, 404].includes(e.status) || i === tries.length - 1) throw i ? firstErr : e;
    }
  }
}

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "history") renderHistory();
  if (name === "settings") { renderDiagnostics(); refreshExportEstimate(); }
}
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
document.querySelectorAll("[data-goto]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); showTab(a.dataset.goto); }));

// ---------- auth proxy key ----------
async function renderProxy() {
  const base = await auth.proxyBase();
  $("proxy-key").value = base;
  $("proxy-status").textContent = base ? `Сервер входа: ${new URL(base).host}/••••` : "Нужен для входа через xAI. Получите ключ у администратора.";
  return base;
}
$("proxy-key").onchange = async (e) => {
  const raw = e.target.value.trim();
  if (!raw) { await kv.del("proxyBase"); await renderProxy(); return; }
  const base = auth.normalizeProxy(raw);
  if (!base) { $("proxy-status").textContent = "Неверный ключ: нужен ключ (от 16 символов: буквы, цифры, - _) или https://… адрес"; return; }
  await kv.set("proxyBase", base);
  await renderProxy();
};

// ---------- account ----------
async function ready() {
  const mode = (await kv.get("authMode")) || "oauth";
  return mode === "apikey" ? !!(await kv.get("apiKey")) : auth.isSignedIn();
}

async function renderAccount() {
  const box = $("account");
  box.innerHTML = "";
  const mode = (await kv.get("authMode")) || "oauth";
  const t = await auth.getTokens();
  if (mode === "apikey") {
    box.innerHTML = `<p>Режим: API-ключ ${(await kv.get("apiKey")) ? "✓" : "(ключ не задан)"}</p>`;
  } else if (t?.access_token) {
    const c = auth.jwtClaims(t.id_token || t.access_token) || {};
    const who = c.email || c.name || c.sub || "аккаунт xAI";
    const p = document.createElement("p");
    p.textContent = `Вход выполнен: ${who}`;
    const out = document.createElement("button");
    out.className = "danger"; out.textContent = "Выйти";
    out.onclick = async () => { await auth.logout(); renderAccount(); };
    box.append(p, out);
  } else {
    const b = document.createElement("button");
    b.className = "primary"; b.textContent = "Войти через xAI";
    b.onclick = login;
    box.append(b);
  }
  $("signin-hint").classList.toggle("hidden", await ready());
}

async function login() {
  const box = $("login-box");
  if (!(await auth.proxyBase())) {
    const raw = prompt("Вставьте ключ сервера (секретный путь или полный https-адрес):");
    const base = auth.normalizeProxy(raw);
    if (!base) { if (raw) alert("Неверный ключ сервера"); $("proxy-key").focus(); return; }
    await kv.set("proxyBase", base);
    await renderProxy();
  }
  try {
    const start = await auth.startDeviceCode();
    $("user-code").textContent = start.userCode;
    $("verify-link").href = start.verificationUri;
    box.classList.remove("hidden");
    $("copy-code").onclick = () => copyText(start.userCode);
    $("cancel-login").onclick = () => { auth.cancelLogin(); box.classList.add("hidden"); };
    await auth.pollDeviceToken(start);
    box.classList.add("hidden");
    await renderAccount();
    showTab("dictate");
    setStatus("Готово. Нажмите, чтобы начать запись");
  } catch (e) {
    box.classList.add("hidden");
    if ((e.message || "") !== "Вход отменён") alert(e.message || String(e));
  }
}

// ---------- recording ----------
function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return "";
}

function setStatus(s) { $("status").textContent = s; }
function setState(s) {
  state = s;
  const btn = $("rec");
  btn.classList.toggle("recording", s === "recording");
  btn.classList.toggle("busy", s === "processing");
  $("rec-icon").textContent = s === "recording" ? "■" : s === "processing" ? "…" : "●";
  $("cancel").classList.toggle("hidden", s !== "recording");
  if (s === "idle") releaseWakeLock(); else acquireWakeLock();
}

// Keep the screen awake while recording/processing (best effort; iOS 16.4+). It does NOT survive an app switch.
let wakeLock = null;
async function acquireWakeLock() {
  try { if (!wakeLock && navigator.wakeLock && !document.hidden) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch (_) {}
}
function releaseWakeLock() { try { wakeLock?.release(); } catch (_) {} wakeLock = null; }

async function startRecording() {
  if (state !== "idle") return;
  if (!(await ready())) { setStatus("Сначала войдите в настройках"); showTab("settings"); return; }
  warmup(true); // open TLS/H2 to api.x.ai and refresh the token while the user is still speaking
  if (!navigator.mediaDevices?.getUserMedia) { setStatus("Браузер не поддерживает запись"); return; }
  const mime = pickMime();
  if (mime === null) { setStatus("MediaRecorder не поддерживается"); return; }
  setState("processing");
  setStatus("Запрашиваю микрофон…");
  let stream;
  try {
    stream = await getMicStream();
  } catch (e) {
    setState("idle");
    setStatus(e.name === "NotAllowedError" ? "Нет доступа к микрофону — нажмите кнопку, чтобы начать" : `Микрофон: ${e.message}`);
    return;
  }
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  rec = { stream, recorder, chunks, mime: recorder.mimeType || mime || "audio/mp4", startedAt: Date.now() };
  recorder.start(1000);
  startMeter(stream);
  rec.timer = setInterval(() => {
    const s = (Date.now() - rec.startedAt) / 1000;
    $("timer").textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    if (s >= MAX_TAKE_SEC) stopAndProcess(false);
  }, 250);
  setState("recording");
  setStatus("Говорите… Нажмите ещё раз, чтобы закончить");
}

async function getMicStream() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
}

function startMeter(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const ring = $("ring");
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      ring.style.transform = `scale(${1 + Math.min(0.25, rms * 2.5)})`;
      rec && (rec.raf = requestAnimationFrame(tick));
    };
    rec.ctx = ctx;
    ctx.resume?.().catch(() => {});
    tick();
  } catch (_) { /* meter is cosmetic */ }
}

function releaseRecorder() {
  if (!rec) return;
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  rec.ctx?.close?.().catch(() => {});
  rec.stream.getTracks().forEach((t) => t.stop()); // release the mic immediately
  $("ring").style.transform = "";
  $("timer").textContent = "";
}

function stopRecorder() {
  return new Promise((resolve) => {
    const r = rec;
    const finish = () => {
      const seconds = (Date.now() - r.startedAt) / 1000;
      releaseRecorder();
      rec = null;
      resolve({ blob: new Blob(r.chunks, { type: r.mime.split(";")[0] }), seconds, mime: r.mime });
    };
    if (r.recorder.state === "inactive") return finish();
    r.recorder.onstop = finish;
    r.recorder.stop();
  });
}

async function cancelRecording() {
  if (state !== "recording") return;
  await stopRecorder();
  setState("idle");
  setStatus("Отменено");
}

const fmtS = (ms) => (ms == null ? "–" : (ms / 1000).toFixed(1).replace(".", ",") + " с");
const countWords = (t) => (t.match(/[\p{L}\p{N}]+/gu) || []).length;

/** Full pipeline for one take. hooks: onRaw(raw, willRefine), onDelta(partial), onFinal(text). Resolves to {text, raw, trace}. */
async function processTake(take, existingId, hooks = {}) {
  if (take.seconds < MIN_TAKE_SEC || take.blob.size < 1000) throw new Error("Слишком короткая запись");
  const trace = take.trace || new Trace({ preset: settings.preset });
  Object.assign(trace.m, { seconds: +take.seconds.toFixed(1), audioBytes: take.blob.size, mime: String(take.mime).split(";")[0], rerun: !!existingId, stream: true });
  const entry = existingId
    ? await history.get(existingId)
    : { createdAt: Date.now(), seconds: take.seconds, mime: take.mime, audio: take.blob, raw: "", text: "", error: "" };
  if (!existingId) { entry.id = await history.add(entry); history.trim(CONFIG.maxHistory).catch(() => {}); }
  trace.mark("saved_audio");
  try {
    setStatus("Распознаю…");
    entry.raw = await transcribe(entry.audio, settings.language, trace);
    trace.mark("stt_done");
    entry.text = entry.raw;
    entry.error = "";
    entry.model = ""; entry.effort = "";
    const words = countWords(entry.raw);
    Object.assign(trace.m, { words, chars: entry.raw.length });
    const willRefine = settings.cleanup && !(settings.skipRefineWords > 0 && words < settings.skipRefineWords);
    if (settings.cleanup && !willRefine) trace.note(`refine skipped: < ${settings.skipRefineWords} words`);
    hooks.onRaw?.(entry.raw, willRefine); // the raw text is on screen (and the clipboard when no refine) right now
    if (willRefine) {
      setStatus("Чищу текст…");
      try {
        const r = await runCleanup(entry.raw, trace, hooks.onDelta);
        entry.text = r.text; entry.error = r.note; entry.model = r.model; entry.effort = r.effort;
      }
      catch (e) { entry.error = `Чистка не удалась, оставлен исходный текст: ${e.message}`; trace.note(`refine failed: ${e.status || e.name}`); }
      trace.mark("refine_done");
    }
    entry.preset = settings.preset; entry.promptMode = promptMode();
    entry.timing = { ...trace.ev, model: trace.m.model || "", effort: trace.m.effort ?? "", preset: trace.m.preset || "", words: trace.m.words, chars: trace.m.chars, net: navigator.connection?.effectiveType || "" };
    hooks.onFinal?.(entry.text);
    $("result-meta").textContent = describeModel(entry, trace);
    await history.put(entry);
    return { text: entry.text, raw: entry.raw, trace };
  } catch (e) {
    entry.error = e.message || String(e);
    trace.note(`failed: ${e.status || e.name || "error"}`);
    await history.put(entry);
    e.trace = trace;
    throw e;
  }
}

async function commitTrace(trace, outcome) {
  trace.mark("end");
  trace.set("outcome", outcome);
  try { if (await timings.enabled()) { await timings.add(trace); if ($("tab-settings").classList.contains("active")) renderDiagnostics(); } } catch (_) {}
}

const deferred = () => { const d = {}; d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; }); d.promise.catch(() => {}); return d; };

/** Called from the Stop tap. The clipboard write is started synchronously, inside the gesture, with a promise for the text:
 *  raw text when there is no refine, the clean text when it arrives within the budget, else the raw text (clean replaces it later). */
function stopAndProcess(fromGesture) {
  if (state !== "recording") return;
  setState("processing");
  resultEdited = false; pendingCopy = null;
  $("copy").classList.remove("pulse");
  const trace = new Trace({ preset: settings.preset });
  const clip = deferred();
  let clipText = null, budgetTimer = null, outcome = "error";
  const hooks = {
    onRaw: (raw, willRefine) => {
      showResult(raw, willRefine ? "raw" : "");
      if (!willRefine) clip.resolve(raw);
      else budgetTimer = setTimeout(() => { trace.note("refine over budget: raw → clipboard"); clip.resolve(raw); }, settings.refineBudgetMs);
    },
    onDelta: (partial) => { if (!resultEdited) showResult(partial, "stream"); },
    onFinal: (text) => { clearTimeout(budgetTimer); if (!resultEdited) showResult(text, ""); clip.resolve(text); },
  };
  const work = stopRecorder().then((take) => { trace.mark("finalize"); take.trace = trace; return processTake(take, undefined, hooks); });
  work.catch((e) => { clearTimeout(budgetTimer); clip.reject(e); });
  let copyPromise = null;
  if (fromGesture && settings.autocopy && window.ClipboardItem && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({ "text/plain": clip.promise.then((t) => { clipText = t; trace.mark("clipboard_text"); return new Blob([t], { type: "text/plain" }); }) });
      copyPromise = navigator.clipboard.write([item]);
    } catch (_) { copyPromise = null; }
  }
  work
    .then(async ({ text }) => {
      clip.resolve(text);
      outcome = trace.ev.rf_total != null ? "ok_refined" : "ok";
      if (resultEdited) { setStatus("Готово. Чистый текст не подставлен: вы уже правили поле (он в Истории)"); return; }
      if (copyPromise) {
        try {
          await copyPromise; trace.mark("clipboard_done");
          if (clipText === text) { flashCopied("Скопировано ✓"); setStatus("Готово — текст в буфере обмена"); }
          else await lateClean(text);
        } catch (_) { outcome += "_nocopy"; setStatus("Готово — нажмите «Скопировать»"); pendingCopy = text; }
      } else {
        setStatus("Готово — нажмите «Скопировать»"); pendingCopy = text;
      }
    })
    .catch((e) => { copyPromise?.catch(() => {}); setStatus(`Ошибка: ${e.message || e}`); })
    .finally(async () => { setState("idle"); await commitTrace(trace, outcome); });
}

/** The clipboard already holds the raw text; the clean text arrived later. Try to replace it, otherwise ask for a tap. */
let pendingCopy = null;
async function lateClean(text) {
  try { await navigator.clipboard.writeText(text); flashCopied("Скопировано ✓"); setStatus("Готово — чистый текст в буфере обмена"); }
  catch (_) {
    pendingCopy = text;
    setStatus("Чистый текст готов (в буфере пока сырой) — нажмите «Скопировать»");
    $("copy").classList.add("pulse");
  }
}

function showResult(text, mode = "") {
  const el = $("result");
  el.value = text;
  el.classList.toggle("raw", mode === "raw");
  el.classList.toggle("stream", mode === "stream");
  $("copy").disabled = !text;
}

function flashCopied(msg) {
  $("copied").textContent = msg;
  setTimeout(() => ($("copied").textContent = ""), 2500);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); flashCopied("Скопировано ✓"); return true; }
  catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove();
    flashCopied(ok ? "Скопировано ✓" : "Не удалось скопировать");
    return ok;
  }
}

$("rec").onclick = () => {
  if (state === "idle") startRecording();
  else if (state === "recording") stopAndProcess(true);
};
$("cancel").onclick = cancelRecording;
$("copy").onclick = () => { pendingCopy = null; $("copy").classList.remove("pulse"); copyText($("result").value); };
$("result").oninput = () => { resultEdited = true; $("copy").disabled = !$("result").value; };

function describeModel(e, trace) {
  const t = trace ? ` · распознавание ${fmtS(trace.ev.stt_total)}${trace.ev.rf_total != null ? `, чистка ${fmtS(trace.ev.rf_total)}` : ""}, всего ${fmtS(trace.ev.refine_done ?? trace.ev.stt_done)}` : "";
  if (!e.model) return "без чистки (только распознавание)" + t;
  return `модель ${e.model}, effort ${e.effort || "по умолчанию"}` + t;
}

// ---------- history ----------
const fmtDate = (ts) => new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

async function renderHistory() {
  const ul = $("history-list");
  ul.innerHTML = "";
  const items = await history.list();
  if (!items.length) { ul.innerHTML = `<li class="small">Пока пусто</li>`; return; }
  for (const e of items) {
    const li = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${fmtDate(e.createdAt)} · ${e.seconds.toFixed(1)} с`;
    const txt = document.createElement("div");
    txt.className = "text";
    txt.textContent = e.text || (e.error ? "" : "…");
    const mm = document.createElement("div");
    mm.className = "meta";
    if (e.raw) mm.textContent = describeModel(e);
    li.append(meta, txt, mm);
    if (e.text && e.raw && e.text !== e.raw) {
      const raw = document.createElement("details");
      raw.innerHTML = `<summary class="small">Исходный текст</summary>`;
      const d = document.createElement("div"); d.className = "text small"; d.textContent = e.raw;
      raw.append(d); li.append(raw);
    }
    if (e.error) { const er = document.createElement("div"); er.className = "err"; er.textContent = e.error; li.append(er); }
    const act = document.createElement("div");
    act.className = "actions";
    const mk = (label, fn, cls = "secondary") => { const b = document.createElement("button"); b.className = cls; b.textContent = label; b.onclick = fn; act.append(b); return b; };
    if (e.text) mk("Копировать", () => copyText(e.text));
    if (e.audio) {
      mk("▶︎", () => { const a = new Audio(URL.createObjectURL(e.audio)); a.play().catch(() => {}); });
      mk("Распознать заново", async (ev) => {
        ev.target.disabled = true;
        try { const t = await processTake({ seconds: e.seconds, blob: e.audio, mime: e.mime }, e.id); showResult(t.text); await commitTrace(t.trace, "rerun_ok"); }
        catch (err) { if (err.trace) await commitTrace(err.trace, "rerun_error"); alert(err.message || err); }
        renderHistory();
      });
    }
    mk("Удалить", async () => { await history.del(e.id); renderHistory(); }, "danger");
    li.append(act);
    ul.append(li);
  }
}
$("clear-history").onclick = async () => { if (confirm("Удалить всю историю?")) { await history.clear(); renderHistory(); } };

async function micPermissionState() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state; } catch (_) { return "unknown"; }
}

/** Best effort: iOS often refuses mic capture without a tap. Never fakes it — falls back to the button. */
async function autostart() {
  if (state !== "idle" || !(await ready())) return;
  const perm = await micPermissionState();
  if (perm !== "denied") await startRecording();
  if (state !== "recording") {
    setStatus("Нажмите кнопку, чтобы начать запись");
    $("rec").classList.add("invite");
    setTimeout(() => $("rec").classList.remove("invite"), 4000);
  }
}

// ---------- diagnostics ----------
async function refreshExportEstimate() {
  const e = await estimate();
  const mb = (b) => (b / 1048576).toFixed(1);
  $("export-info").textContent = e.count
    ? `В истории ${e.count} записей. Файл без аудио ≈ ${Math.max(1, Math.round(e.textBytes / 1024))} КБ, аудио добавит ≈ ${mb(e.audioBytes)} МБ.`
    : "История пуста.";
}
const DIAG_COLS = [["stt_total", "STT"], ["stt_token", "токен"], ["rf_first", "чистка: 1-й токен"], ["rf_total", "чистка"], ["refine_done", "до чистого текста"], ["clipboard_done", "до буфера"]];

async function renderDiagnostics() {
  const list = await timings.list();
  const box = $("diag-stats");
  const ok = list.filter((e) => String(e.outcome || "").startsWith("ok"));
  const st = summarize(ok, DIAG_COLS.map((c) => c[0]));
  let html = `<table class="diag"><tr><th>этап, мс</th><th>n</th><th>p50</th><th>p95</th></tr>`;
  for (const [k, label] of DIAG_COLS) html += `<tr><td>${label}</td><td>${st[k].n}</td><td>${st[k].p50 ?? "–"}</td><td>${st[k].p95 ?? "–"}</td></tr>`;
  html += `</table>`;
  const rows = list.slice(-10).reverse().map((e) =>
    `<tr><td>${new Date(e.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</td><td>${e.seconds ?? "–"}с/${e.words ?? "–"}сл</td><td>${e.stt_total ?? "–"}</td><td>${e.rf_total ?? "–"}</td><td>${e.refine_done ?? e.stt_done ?? "–"}</td><td>${(e.model || "").replace("grok-", "").replace("-0309-non-reasoning", "-nr") || "–"}</td><td>${e.outcome || ""}</td></tr>`).join("");
  box.innerHTML = list.length ? html + `<table class="diag"><tr><th>время</th><th>длина</th><th>STT</th><th>чистка</th><th>всего</th><th>модель</th><th></th></tr>${rows}</table>` : `<p class="small">Замеров пока нет — продиктуйте что-нибудь.</p>`;
}

// ---------- boot ----------
async function markInterrupted() {
  // Entries left without text/error by a previous page life (iOS killed the tab mid-request).
  for (const e of await history.list()) {
    if (e.audio && !e.raw && !e.error) { e.error = "Прервано: приложение было свёрнуто или закрыто во время обработки. Нажмите «Распознать заново»."; await history.put(e); }
  }
}

async function boot() {
  bindSettings();
  await loadSettings();
  ready().then((ok) => ok && warmup(true));
  markInterrupted().catch(() => {});
  renderDiagnostics();
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) return;
    if (state !== "idle") acquireWakeLock();
    if (await ready()) warmup();
    if (pendingCopy) { // a result finished while the app was in the background
      try { await navigator.clipboard.writeText(pendingCopy); pendingCopy = null; $("copy").classList.remove("pulse"); flashCopied("Скопировано ✓"); setStatus("Готово — текст в буфере обмена"); }
      catch (_) { $("copy").classList.add("pulse"); setStatus("Результат готов — нажмите «Скопировать»"); }
    }
  });
  await renderProxy();
  await renderAccount();
  navigator.storage?.persist?.().catch(() => {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  $("diag").textContent = `Версия ${APP_VERSION} · Микрофон: ${await micPermissionState()} · Формат записи: ${pickMime() || "по умолчанию"} · ${standalone ? "режим приложения" : "в браузере"} · ClipboardItem: ${window.ClipboardItem ? "да" : "нет"}`;
  if (AUTOSTART) {
    await autostart();
    // Re-opening an already running PWA (Action Button / Back Tap) may only bring it to the front.
    let hiddenAt = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (state === "idle" && hiddenAt && Date.now() - hiddenAt > 1500) autostart();
    });
  }
}
boot();
