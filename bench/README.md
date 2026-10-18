# Benchmarks (2026-10-18)

Run on the VPS under the Hermes venv Python: the token comes from Hermes' OAuth resolver in-process and is never printed.
Test audio is synthetic (xAI TTS, Russian phrases), not recordings of a person. Scripts expect files in `/tmp` (see the headers).

- `xb.py` timing harness (DNS / TCP / TLS / TTFB / total, SSE first token); `bench_stt.py`, `bench_refine.py`, `bench_quality.py`, `bench_long.py`.
- `real.mjs` + `realrun.py`: run the REAL `web/grok.js` (Node 22, auth/db stubbed) against the real API: before/after table.
- `e2e.js`: Chromium test against a local mock `api.x.ai` (HTTPS with a self-signed cert, `--host-resolver-rules`, real chunked SSE).
  `node e2e.js <web dir> <label> [baseline|smart|budget|fallback|retry|skip]`
- `sse_test.mjs`: the SSE parser against a real captured response, split at arbitrary byte boundaries.
