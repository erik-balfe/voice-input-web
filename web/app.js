import { CONFIG } from "./config.js";
import { kv, history } from "./db.js";
import * as auth from "./auth.js";
import { transcribe, cleanup, HttpError } from "./grok.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const AUTOSTART = params.get("autostart") === "1";
const MAX_TAKE_SEC = 300;
const MIN_TAKE_SEC = 0.5;
const APP_VERSION = "2026-10-13.2";


const settings = {
  language: "ru",
  cleanup: false,
  autocopy: true,
  cleanupModel: CONFIG.defaultCleanupModel,
  cleanupEffort: CONFIG.defaultCleanupEffort, // "" = model default (not sent)
  cleanupPrompt: CONFIG.defaultCleanupPrompt,
};

let state = "idle"; // idle | recording | processing
let rec = null; // { stream, recorder, chunks, mime, startedAt, ctx, raf, timer }

// ---------- settings ----------
async function loadSettings() {
  const saved = (await kv.get("settings")) || {};
  Object.assign(settings, saved);
  // Migrate old defaults; keep anything the user chose deliberately.
  let migrated = false;
  if (!saved.cleanupModel || CONFIG.legacyCleanupModels.includes(saved.cleanupModel)) {
    if (settings.cleanupModel !== CONFIG.defaultCleanupModel) migrated = true;
    settings.cleanupModel = CONFIG.defaultCleanupModel;
    settings.cleanupEffort = CONFIG.defaultCleanupEffort;
  }
  if (!saved.cleanupPrompt || CONFIG.legacyCleanupPrompts.includes(saved.cleanupPrompt.trim())) {
    if (saved.cleanupPrompt) migrated = true;
    settings.cleanupPrompt = CONFIG.defaultCleanupPrompt;
  }
  if (migrated) await saveSettings();
  $("language").value = settings.language;
  $("cleanup").checked = settings.cleanup;
  $("cleanup-quick").checked = settings.cleanup;
  $("autocopy").checked = settings.autocopy;
  renderModelControls();
  $("cleanup-prompt").value = settings.cleanupPrompt;
  $("use-apikey").checked = ((await kv.get("authMode")) || "oauth") === "apikey";
  $("apikey").value = (await kv.get("apiKey")) || "";
}
const saveSettings = () => kv.set("settings", { ...settings });

function bindSettings() {
  $("language").onchange = (e) => { settings.language = e.target.value; saveSettings(); };
  const setCleanup = (v) => { settings.cleanup = v; $("cleanup").checked = v; $("cleanup-quick").checked = v; saveSettings(); };
  $("cleanup").onchange = (e) => setCleanup(e.target.checked);
  $("cleanup-quick").onchange = (e) => setCleanup(e.target.checked);
  $("autocopy").onchange = (e) => { settings.autocopy = e.target.checked; saveSettings(); };
  $("cleanup-model-select").onchange = (e) => {
    const v = e.target.value;
    if (v === "__custom") { settings.cleanupModel = $("cleanup-model-custom").value.trim() || settings.cleanupModel; showCustom(true); }
    else { settings.cleanupModel = v; const m = modelInfo(v); settings.cleanupEffort = m?.efforts ? m.defaultEffort : ""; }
    saveSettings(); renderModelControls();
  };
  $("cleanup-model-custom").onchange = (e) => { const v = e.target.value.trim(); if (v) { settings.cleanupModel = v; saveSettings(); renderModelControls(); } };
  $("cleanup-effort").onchange = (e) => { settings.cleanupEffort = e.target.value; saveSettings(); };
  $("cleanup-prompt").onchange = (e) => { settings.cleanupPrompt = e.target.value.trim() || CONFIG.defaultCleanupPrompt; saveSettings(); };
  $("reset-prompt").onclick = () => {
    settings.cleanupModel = CONFIG.defaultCleanupModel; settings.cleanupPrompt = CONFIG.defaultCleanupPrompt;
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

/** Cleanup with automatic fallback when the chosen model is rejected (e.g. not available to the OAuth token). */
async function runCleanup(raw) {
  try {
    const effort = settings.cleanupEffort || "";
    return { text: await cleanup(raw, settings.cleanupModel, settings.cleanupPrompt, effort || undefined), note: "", model: settings.cleanupModel, effort };
  } catch (e) {
    const fb = CONFIG.fallbackCleanupModel;
    if (!(e instanceof HttpError) || ![400, 403, 404].includes(e.status) || settings.cleanupModel === fb) throw e;
    const text = await cleanup(raw, fb, settings.cleanupPrompt, modelInfo(fb).defaultEffort);
    return { text, model: fb, effort: modelInfo(fb).defaultEffort, note: `Модель ${settings.cleanupModel} отклонена (${e.message.slice(0, 120)}), использована ${fb}` };
  }
}

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "history") renderHistory();
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
}

async function startRecording() {
  if (state !== "idle") return;
  if (!(await ready())) { setStatus("Сначала войдите в настройках"); showTab("settings"); return; }
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

/** Full pipeline for one take. Resolves to the final text. */
async function processTake(take, existingId) {
  if (take.seconds < MIN_TAKE_SEC || take.blob.size < 1000) throw new Error("Слишком короткая запись");
  const entry = existingId
    ? await history.get(existingId)
    : { createdAt: Date.now(), seconds: take.seconds, mime: take.mime, audio: take.blob, raw: "", text: "", error: "" };
  if (!existingId) { entry.id = await history.add(entry); await history.trim(CONFIG.maxHistory); }
  try {
    setStatus("Распознаю…");
    entry.raw = await transcribe(entry.audio, settings.language);
    entry.text = entry.raw;
    entry.error = "";
    entry.model = ""; entry.effort = "";
    if (settings.cleanup) {
      setStatus("Чищу текст…");
      try {
        const r = await runCleanup(entry.raw);
        entry.text = r.text; entry.error = r.note; entry.model = r.model; entry.effort = r.effort;
      }
      catch (e) { entry.error = `Чистка не удалась, оставлен исходный текст: ${e.message}`; }
    }
    await history.put(entry);
    $("result-meta").textContent = describeModel(entry);
    return entry.text;
  } catch (e) {
    entry.error = e.message || String(e);
    await history.put(entry);
    throw e;
  }
}

/** Called from the Stop tap. Clipboard write is started synchronously, inside the gesture. */
function stopAndProcess(fromGesture) {
  if (state !== "recording") return;
  setState("processing");
  const textPromise = stopRecorder().then((take) => processTake(take));
  let copyPromise = null;
  if (fromGesture && settings.autocopy && window.ClipboardItem && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({ "text/plain": textPromise.then((t) => new Blob([t], { type: "text/plain" })) });
      copyPromise = navigator.clipboard.write([item]);
    } catch (_) { copyPromise = null; }
  }
  textPromise
    .then(async (text) => {
      showResult(text);
      if (copyPromise) {
        try { await copyPromise; flashCopied("Скопировано ✓"); setStatus("Готово — текст в буфере обмена"); }
        catch (_) { setStatus("Готово — нажмите «Скопировать»"); }
      } else {
        setStatus("Готово — нажмите «Скопировать»");
      }
    })
    .catch((e) => { copyPromise?.catch(() => {}); setStatus(`Ошибка: ${e.message || e}`); })
    .finally(() => setState("idle"));
}

function showResult(text) {
  $("result").value = text;
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
$("copy").onclick = () => copyText($("result").value);
$("result").oninput = () => ($("copy").disabled = !$("result").value);

function describeModel(e) {
  if (!e.model) return "без чистки (только распознавание)";
  return `модель ${e.model}, effort ${e.effort || "по умолчанию"}`;
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
        try { const t = await processTake({ seconds: e.seconds, blob: e.audio, mime: e.mime }, e.id); showResult(t); }
        catch (err) { alert(err.message || err); }
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

// ---------- boot ----------
async function boot() {
  bindSettings();
  await loadSettings();
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
