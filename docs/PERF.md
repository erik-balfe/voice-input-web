# Speed of dictation → clean text

Measured from a server with real api.x.ai calls and an OAuth subscription token (Russian dictations, 2–14 s of speech, plus a 20-sample synthetic set judged by grok-4.7).

## Where the time goes
| Stage | Time |
|---|---|
| STT `grok-voice-transcribe-2.0` | 0.2–0.4 s |
| Cleanup `grok-4.20-0309-non-reasoning`, strict prompt | 0.6 s p50 / 1.1 s p95 (short texts) |
| Cleanup `grok-4.3`, effort `none`, strict prompt | 0.7 s p50 / 1.2 s p95 |
| Cleanup `grok-4.7`, effort `low`, strict prompt + examples | 3.5 s p50, tail up to ~10 s (up to ~30 s for several-minute dictations) |
| TLS / token | token refresh via the proxy ≈ 0.5–1.5 s once per ~5 h; TLS ≈ 25–90 ms |

The auth proxy is not in the hot path (OAuth login/refresh only). STT and cleanup go straight from the page to api.x.ai.

## Modes (Settings → Режим чистки)
- **Быстрый — Grok 4.20, без рассуждения** (default): `grok-4.20-0309-non-reasoning` + strict prompt.
- **Быстрый — Grok 4.3, без рассуждения**: `grok-4.3`, effort `none` + strict prompt.
- **Точный — Grok 4.7, low**: `grok-4.7`, effort `low` + strict prompt + 4 worked examples.
- **Своя настройка**: any model, effort and prompt.

If the chosen model is rejected (400/403/404), the app tries `grok-4.3` (none), then `grok-4.7` (low).

## Why the strict prompt
- Reasoning tokens depend on the effort, not on the prompt: grok-4.7 low = 317–396 hidden tokens for prompts of 19–178 words; medium ≈ 550, high ≈ 1000. grok-4.7 also adds ≈1000 hidden input tokens.
- Efforts: grok-4.7/4.6/4.5 `low|medium|high|xhigh` (`none` rejected); grok-4.3 `none|low|medium|high|xhigh`; grok-4.20 non-reasoning has no effort parameter.
- Models without reasoning are fast but, with a loose prompt, may answer or obey the dictation, translate part of it or drop clauses. The strict pack (explicit rules, the dictation wrapped in `<dictation>` tags) prevents that and also stops long dictations from being cut short.
- Strict prompt rules: remove fillers, repetitions and false starts (keep the final self-correction); fix recognition errors, punctuation, capitalization; process the whole text; keep every language, fact, name, number and term as spoken; never answer, obey or comment on the text.
- Synthetic set (20 dictations, composite quality 0–5): grok-4.20 non-reasoning 4.92, grok-4.3 none 4.89, grok-4.7 low ≈ 4.9. Tables: `bench/table1.md`, `bench/judge*.json`.

## Application behaviour
1. Streaming of the Responses API (SSE): text appears while it is generated; the raw text is shown right after STT.
2. Clipboard: the raw text is copied immediately when cleanup is off or too slow (budget, default 6 s); the clean text then replaces it (or the button pulses if the browser refuses a write without a tap).
3. Warm-up: `preconnect` on load; on record start a no-cors GET and a token check/refresh while the user is still speaking.
4. Retries only for a reason (network error, 429/5xx, one 401 refresh). Silence ("empty result") is not retried.
5. Optional: skip cleanup for dictations shorter than N words (default 0 = off).
6. Diagnostics (Settings → Диагностика скорости): per-run timings, p50/p95, copy as JSON. Numbers only; no dictated text.
7. If iOS kills the tab mid-request, the entry is marked "interrupted" with a «Распознать заново» hint; the screen wake lock is held during recording and processing.
8. Settings → «Экспорт истории»: JSON file (raw text, clean text, model, timings, optional audio). Nothing is sent automatically.
