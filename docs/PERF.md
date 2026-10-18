# Speed of dictation → clean text (2026-10-18)

Problem: after Stop, recognition + cleanup took 10–15 s for a short dictation.

## Where the time went (measured from the VPS, real api.x.ai, OAuth subscription token)
| Stage | Time |
|---|---|
| STT `grok-voice-transcribe-2.0` (m4a/webm, 2–14 s of speech) | 0.2–0.4 s (not the bottleneck) |
| Cleanup `grok-4.7`, effort `low` (old default) | 3.8 s p50 (short), 5.2 s (14 s dictation), tail 7–9 s: the model "thinks" 280–400 hidden tokens for a ~25-token answer |
| TLS / token / proxy | token refresh via the Funnel proxy ≈ 0.5–1.5 s once per ~5 h; TLS ≈ 25–90 ms |

The auth proxy is not in the hot path (only OAuth login/refresh). STT and cleanup go straight from the page to api.x.ai.

## What changed
1. Default cleanup preset **«Быстро»**: `grok-4.20-0309-non-reasoning` (no reasoning) + a tighter prompt with explicit filler list and 3 examples. «Аккуратно» = the old grok-4.7/low + old prompt. Fallback chain if a model is rejected: grok-4.3 (none) → grok-4.7 (low).
2. Streaming of the Responses API (SSE): text appears while it is generated; raw text is shown right after STT.
3. Clipboard: raw text is copied immediately when refine is off or too slow (budget, default 6 s); the clean text then replaces it (or the button pulses if the browser refuses a write without a tap).
4. Warm-up: `preconnect` on load, and on Stop-tap-start a no-cors GET + token check/refresh while the user is still speaking.
5. Retries only for a reason (network error, 429/5xx, one 401 refresh). Silence ("empty result") is not retried any more (it used to cost 4 requests + 3.5 s of sleeps).
6. Option: skip cleanup for dictations shorter than N words (default 0 = off).
7. Diagnostics (Settings → Диагностика скорости): per-run timings, p50/p95, copy as JSON. Numbers only; no dictated text.
8. If iOS kills the tab mid-request, the entry is marked "interrupted" with a «Распознать заново» hint; screen wake lock during recording/processing.
