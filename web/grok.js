// api.x.ai calls (CORS allowed by api.x.ai). Request format mirrors voice-input-android GrokSttClient.kt:
// multipart model, format=true, language, then file last; up to 3 retries, 500 ms doubling backoff.
import { CONFIG } from "./config.js";
import { bearer, refresh } from "./auth.js";
import { kv } from "./db.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, body) { super(`HTTP ${status}: ${String(body).slice(0, 200)}`); this.status = status; }
}

export async function transcribe(blob, language) {
  const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("ogg") ? "ogg" : "m4a";
  let last;
  let refreshed = false;
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const fd = new FormData();
      fd.append("model", CONFIG.sttModel);
      fd.append("format", "true");
      fd.append("language", language);
      fd.append("file", blob, `recording.${ext}`);
      const res = await fetch(CONFIG.sttUrl, { method: "POST", headers: { Authorization: `Bearer ${await bearer()}` }, body: fd });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text);
      const out = (JSON.parse(text).text || "").trim();
      if (!out) throw new Error("Пустой результат распознавания");
      return out;
    } catch (e) {
      last = e;
      if (e instanceof HttpError) {
        if (e.status === 401 && !refreshed && ((await kv.get("authMode")) || "oauth") === "oauth") {
          refreshed = true;
          try { await refresh(true); } catch (_) {}
          attempt--; // retry immediately
          continue;
        }
        if ([400, 403, 413].includes(e.status)) throw e;
      }
    }
  }
  throw last;
}

/** Optional cleanup through the Responses API (same bearer). */
export async function cleanup(text, model, prompt, effort) {
  const payload = {
    model,
    store: false,
    input: [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ],
  };
  if (effort) payload.reasoning = { effort };
  const res = await fetch(CONFIG.responsesUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${await bearer()}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new HttpError(res.status, body);
  const json = JSON.parse(body);
  let out = typeof json.output_text === "string" ? json.output_text : "";
  if (!out) {
    for (const item of json.output || []) {
      if (item.type !== "message") continue;
      for (const part of item.content || []) if (part.type === "output_text" && part.text) out += part.text;
    }
  }
  out = out.trim();
  if (!out) throw new Error("Пустой ответ cleanup");
  return out;
}
