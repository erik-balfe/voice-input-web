# Grok Voice (web)

Voice input PWA for iPhone: tap → speak → tap → text is transcribed by xAI Grok STT
(`grok-voice-transcribe-2.0`), optionally cleaned up by Grok, and copied to the clipboard.
Sign-in uses your Grok account (xAI OAuth device flow, same public client as
[voice-input-android](https://github.com/erik-balfe/voice-input-android)); no API key needed.

**App:** https://erik-balfe.github.io/voice-input-web/ · autostart: `https://erik-balfe.github.io/voice-input-web/?autostart=1`

## How it works

- `web/` – static PWA (GitHub Pages). Tokens, settings and history (with audio) live in IndexedDB on the device.
- STT (`POST https://api.x.ai/v1/stt`) and cleanup (`POST https://api.x.ai/v1/responses`) are called
  directly from the page – api.x.ai allows CORS.
- `auth.x.ai` has no CORS, so the two OAuth calls go through a tiny stateless proxy, see [`proxy/`](proxy/).
- Stop tap → `navigator.clipboard.write([new ClipboardItem({"text/plain": promise})])` is issued inside the
  tap, and the promise resolves once STT/cleanup finish, so Safari accepts the copy without a second tap.
- `?autostart=1` starts recording on open (if the mic permission is already granted); otherwise one tap.

No secrets in this repo. The client id is the public Grok CLI client.

Russian setup guide: [docs/SETUP.ru.md](docs/SETUP.ru.md)
