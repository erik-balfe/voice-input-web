// api.x.ai calls (CORS allowed by api.x.ai). Request format mirrors voice-input-android GrokSttClient.kt:
// multipart model, format=true, language, then file last.
// Retries only for a reason: network error, HTTP 429/5xx, or one forced token refresh on 401.
// Empty recognition (silence) and 4xx are never retried.
import { CONFIG } from "./config.js";
import { bearer, refresh } from "./auth.js";
import { kv } from "./db.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

export class HttpError extends Error {
  constructor(status, body) { super(`HTTP ${status}: ${String(body).slice(0, 200)}`); this.status = status; }
}
export class EmptyResult extends Error {}

const retryable = (e) => !(e instanceof EmptyResult) && (!(e instanceof HttpError) || e.status === 429 || e.status >= 500);
const isAbort = (e) => e && e.name === "AbortError";

/** fetch with a hard timeout and an optional outer abort signal. */
async function timedFetch(url, init, timeoutMs, outer) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const onOuter = () => ac.abort();
  outer?.addEventListener("abort", onOuter);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); outer?.removeEventListener("abort", onOuter); }
}

/** Warm up the connection (DNS+TCP+TLS+H2) to api.x.ai and make sure the OAuth token is fresh, before it is needed. */
let lastWarm = 0;
export async function warmup(force = false) {
  if (!force && Date.now() - lastWarm < 20_000) return;
  lastWarm = Date.now();
  try { fetch(CONFIG.warmUrl, { method: "GET", mode: "no-cors", cache: "no-store", credentials: "omit" }).catch(() => {}); } catch (_) {}
  try { await bearer(); } catch (_) { /* surfaced later with a proper message */ }
}

export async function transcribe(blob, language, trace) {
  const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("ogg") ? "ogg" : "m4a";
  let last, refreshed = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await sleep(300 * 2 ** (attempt - 2));
    try {
      trace?.set("stt_attempts", attempt);
      const endTok = trace?.span("stt_token");
      const token = await bearer();
      endTok?.();
      const fd = new FormData();
      fd.append("model", CONFIG.sttModel);
      fd.append("format", "true");
      fd.append("language", language);
      fd.append("file", blob, `recording.${ext}`);
      const t0 = now();
      const res = await timedFetch(CONFIG.sttUrl, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd }, CONFIG.sttTimeoutMs);
      trace?.set("stt_ttfb", now() - t0);
      const text = await res.text();
      trace?.set("stt_total", now() - t0);
      if (!res.ok) throw new HttpError(res.status, text);
      const out = (JSON.parse(text).text || "").trim();
      if (!out) throw new EmptyResult("Пустой результат распознавания");
      return out;
    } catch (e) {
      last = e;
      if (e instanceof HttpError && e.status === 401 && !refreshed && ((await kv.get("authMode")) || "oauth") === "oauth") {
        refreshed = true; trace?.note("401 → token refresh");
        try { await refresh(true); } catch (_) {}
        attempt--; continue;
      }
      if (isAbort(e)) last = new Error("Распознавание: таймаут");
      if (!retryable(e) && !isAbort(e)) throw e;
      trace?.note(`stt retry: ${e.status || e.name || "net"}`);
    }
  }
  throw last;
}

function extractText(json) {
  let out = typeof json.output_text === "string" ? json.output_text : "";
  if (!out) {
    for (const item of json.output || []) {
      if (item.type !== "message") continue;
      for (const part of item.content || []) if (part.type === "output_text" && part.text) out += part.text;
    }
  }
  return out;
}

/** Parse an SSE stream of the Responses API. Calls onDelta(totalSoFar). Returns the final text. */
export async function readResponsesStream(body, onDelta, trace, t0) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", out = "", final = "", first = true;
  const handle = (block) => {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let ev; try { ev = JSON.parse(data); } catch (_) { return; }
    if (ev.type === "response.output_text.delta" && ev.delta) {
      if (first) { first = false; trace?.set("rf_first", now() - t0); }
      out += ev.delta; onDelta?.(out);
    } else if (ev.type === "response.completed") final = extractText(ev.response || {});
    else if (ev.type === "response.failed" || ev.type === "error") {
      throw new HttpError(500, JSON.stringify(ev.response?.error || ev.error || ev).slice(0, 200));
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      buf += dec.decode(value, { stream: !done });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
    if (done) break;
  }
  if (buf.trim()) handle(buf);
  return (out || final).trim();
}

/** Cleanup through the Responses API (same bearer). Streams when possible: onDelta(textSoFar). */
export async function cleanup(text, model, prompt, effort, { trace, onDelta, signal, stream = true } = {}) {
  const payload = { model, store: false, input: [{ role: "system", content: prompt }, { role: "user", content: text }] };
  if (effort) payload.reasoning = { effort };
  const canStream = stream && typeof ReadableStream !== "undefined";
  if (canStream) payload.stream = true;
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      trace?.set("rf_attempts", attempt);
      const endTok = trace?.span("rf_token");
      const token = await bearer();
      endTok?.();
      const t0 = now();
      const res = await timedFetch(CONFIG.responsesUrl, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload),
      }, CONFIG.refineTimeoutMs, signal);
      trace?.set("rf_ttfb", now() - t0);
      if (!res.ok) throw new HttpError(res.status, await res.text());
      let out;
      if (canStream && res.body && (res.headers.get("content-type") || "").includes("text/event-stream")) {
        out = await readResponsesStream(res.body, onDelta, trace, t0);
      } else {
        out = extractText(JSON.parse(await res.text())).trim();
        trace?.set("rf_first", now() - t0);
      }
      trace?.set("rf_total", now() - t0);
      if (!out) throw new EmptyResult("Пустой ответ cleanup");
      return out;
    } catch (e) {
      last = e;
      if (e instanceof HttpError && e.status === 401 && attempt === 1) { try { await refresh(true); } catch (_) {} trace?.note("rf 401 → refresh"); continue; }
      // one retry only for a transient network failure (iOS drops fetches when the tab was backgrounded) or 5xx/429
      if (attempt === 1 && !signal?.aborted && !isAbort(e) && retryable(e)) { trace?.note(`rf retry: ${e.status || e.name || "net"}`); await sleep(250); continue; }
      if (isAbort(e)) throw signal?.aborted ? e : new Error("Чистка: таймаут");
      throw e;
    }
  }
  throw last;
}
