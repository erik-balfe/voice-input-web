// Timing diagnostics. Stores ONLY numbers and technical labels (model, sizes, counts): never dictated text, audio or tokens.
import { kv } from "./db.js";

const KEY = "timings";
const MAX = 100;
const now = () => performance.now();
const r1 = (x) => (x == null ? null : Math.round(x));

/** One pipeline run. Marks are ms since the Stop tap (t0). */
export class Trace {
  constructor(meta = {}) {
    this.t0 = now();
    this.at = Date.now();
    this.m = { ...meta }; // static facts: seconds, audioBytes, mime, model, effort, preset, stream, words...
    this.ev = {};         // phase durations / marks in ms
    this.notes = [];
  }
  /** mark(name): ms since Stop tap */
  mark(name) { this.ev[name] = r1(now() - this.t0); }
  /** span(name) -> end(): duration of a phase in ms (accumulates over retries as name_n) */
  span(name) {
    const s = now();
    return () => { const d = r1(now() - s); this.ev[name] = (this.ev[name] || 0) + d; return d; };
  }
  set(name, v) { this.ev[name] = typeof v === "number" ? r1(v) : v; }
  note(s) { this.notes.push(String(s).slice(0, 120)); }
  toJSON() {
    const net = navigator.connection;
    return { at: new Date(this.at).toISOString(), ...this.m, ...this.ev, notes: this.notes.length ? this.notes : undefined,
      net: net ? `${net.effectiveType || "?"}/${net.rtt ?? "?"}ms` : undefined };
  }
}

export const timings = {
  async enabled() { return ((await kv.get("settings")) || {}).timings !== false; },
  async add(trace) {
    const all = (await kv.get(KEY)) || [];
    all.push(trace.toJSON());
    await kv.set(KEY, all.slice(-MAX));
  },
  async list() { return (await kv.get(KEY)) || []; },
  async clear() { await kv.del(KEY); },
};

export function pct(xs, p) {
  const a = xs.filter((x) => typeof x === "number").sort((x, y) => x - y);
  if (!a.length) return null;
  const k = (a.length - 1) * p, f = Math.floor(k), c = Math.min(f + 1, a.length - 1);
  return Math.round(a[f] + (a[c] - a[f]) * (k - f));
}

/** p50/p95 per metric over the given runs. */
export function summarize(list, keys) {
  const out = {};
  for (const k of keys) {
    const xs = list.map((e) => e[k]);
    out[k] = { n: xs.filter((x) => typeof x === "number").length, p50: pct(xs, 0.5), p95: pct(xs, 0.95) };
  }
  return out;
}
