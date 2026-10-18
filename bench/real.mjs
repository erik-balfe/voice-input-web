// Runs the REAL new grok.js against the REAL api.x.ai (from the VPS); auth/db stubbed (token comes from env, never printed).
import { transcribe, cleanup } from "./web/grok.js";
import { CONFIG } from "./web/config.js";
import { Trace, pct } from "./web/metrics.js";
import fs from "node:fs";
const lang = "ru";
const audio = { short: "/tmp/a_short.webm", mid: "/tmp/a_mid.webm" };
const N = Number(process.env.N || 5);
const cfgs = [
  { name: "BEFORE  grok-4.7 low, careful prompt, no stream", model: "grok-4.7", effort: "low", prompt: CONFIG.carefulCleanupPrompt, stream: false },
  { name: "grok-4.7 low, careful prompt, stream",           model: "grok-4.7", effort: "low", prompt: CONFIG.carefulCleanupPrompt, stream: true },
  { name: "grok-4.3 none, fast prompt, stream",              model: "grok-4.3", effort: "none", prompt: CONFIG.fastCleanupPrompt, stream: true },
  { name: "AFTER   grok-4.20 non-reasoning, fast prompt, stream", model: "grok-4.20-0309-non-reasoning", effort: "", prompt: CONFIG.fastCleanupPrompt, stream: true },
];
const out = []; const errs = [];
for (const [an, path] of Object.entries(audio)) {
  const blob = new Blob([fs.readFileSync(path)], { type: "audio/webm" });
  for (const c of cfgs) {
    const rows = [];
    for (let i = 0; i < N; i++) {
      const tr = new Trace({});
      const t0 = performance.now();
      const raw = await transcribe(blob, lang, tr);
      const t1 = performance.now();
      let clean = "";
      try { clean = await cleanup(raw, c.model, c.prompt, c.effort || undefined, { trace: tr, stream: c.stream }); }
      catch (e) { clean = "ERR " + e.message; errs.push(`${c.name}: ${e.message} after ${((performance.now() - t1) / 1000).toFixed(1)}s notes=${tr.notes}`); }
      const t2 = performance.now();
      rows.push({ stt: t1 - t0, rf: t2 - t1, first: tr.ev.rf_first, e2e: t2 - t0, att: tr.ev.rf_attempts, clean });
    }
    const f = (k) => `${(pct(rows.map(r => r[k]), .5) / 1000).toFixed(2)}/${(pct(rows.map(r => r[k]), .95) / 1000).toFixed(2)}/${(Math.max(...rows.map(r => r[k] ?? 0)) / 1000).toFixed(2)}`;
    console.log(`${an.padEnd(5)} ${c.name.padEnd(56)} STT p50/p95/max ${f("stt")}  refine ${f("rf")}  1st-token ${f("first")}  STT+refine ${f("e2e")} s  n=${N} attempts=${rows.map(r=>r.att).join("")}`);
    out.push({ an, c: c.name, rows: rows.map(r => ({ ...r, clean: undefined })) });
  }
}
fs.writeFileSync("/tmp/real-out.json", JSON.stringify(out));

console.log("errors:", errs.length ? errs : "none");
