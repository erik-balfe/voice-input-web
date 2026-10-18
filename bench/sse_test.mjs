import { readResponsesStream } from "/workspace/voice-input-web/web/grok.js";
import fs from "node:fs";
const buf = fs.readFileSync("/workspace/vbench/sse_sample.txt");
// split at arbitrary byte offsets, including mid-UTF-8 sequences and mid-event
for (const size of [1, 3, 7, 64, 500, buf.length]) {
  const parts = []; for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  const stream = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new Uint8Array(p)); c.close(); } });
  const deltas = []; const out = await readResponsesStream(stream, (t) => deltas.push(t), null, performance.now());
  console.log("chunk", String(size).padStart(5), "->", JSON.stringify(out), "deltas:", deltas.length);
}
