// Manual export of the dictation history (+ timings) as a JSON file for diagnostics/benchmarks.
// Nothing here runs automatically and nothing is sent anywhere: the user taps «Поделиться» / «Скачать».
import { kv, history } from "./db.js";
import { timings } from "./metrics.js";

const blobToB64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** Plain numbers/text for the export; audio only when asked. */
export async function buildExport({ audio = false, appVersion = "" } = {}) {
  const items = (await history.list()).slice().reverse(); // oldest first
  const settings = (await kv.get("settings")) || {};
  const out = {
    format: "grokvoice-export-1",
    app: appVersion,
    exportedAt: new Date().toISOString(),
    includesAudio: !!audio,
    settings: {
      language: settings.language, preset: settings.preset, cleanupModel: settings.cleanupModel,
      cleanupEffort: settings.cleanupEffort, cleanupPrompt: settings.cleanupPrompt, cleanup: settings.cleanup,
      skipRefineWords: settings.skipRefineWords, refineBudgetMs: settings.refineBudgetMs,
    },
    timings: await timings.list(),
    history: [],
  };
  for (const e of items) {
    const row = {
      id: e.id, createdAt: new Date(e.createdAt).toISOString(), seconds: e.seconds, mime: e.mime,
      raw: e.raw || "", text: e.text || "", model: e.model || "", effort: e.effort || "", error: e.error || "",
      timing: e.timing || null,
    };
    if (audio && e.audio) {
      try { row.audio = { mime: e.audio.type || e.mime, bytes: e.audio.size, base64: await blobToB64(e.audio) }; }
      catch (_) { row.audioError = "read failed"; }
    }
    out.history.push(row);
  }
  return out;
}

export async function exportFile(opts) {
  const data = await buildExport(opts);
  const json = JSON.stringify(data);
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const name = `grokvoice-history-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  const file = new File([json], name, { type: "application/json" });
  return { file, name, count: data.history.length, bytes: file.size };
}

/** Share sheet with the file (iOS/Android), false if the browser cannot share files. */
export async function shareFile(file, count) {
  if (!navigator.canShare || !navigator.canShare({ files: [file] })) return false;
  await navigator.share({ files: [file], title: "Grok Voice: история для диагностики", text: `${count} записей` });
  return true;
}

export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Quick size estimate without building the whole file. */
export async function estimate() {
  const items = await history.list();
  let audioBytes = 0, textBytes = 0;
  for (const e of items) { audioBytes += e.audio?.size || 0; textBytes += (e.raw || "").length * 2 + (e.text || "").length * 2 + 300; }
  return { count: items.length, textBytes, audioBytes: Math.round(audioBytes * 4 / 3) };
}
