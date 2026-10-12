# xai-auth-proxy

`auth.x.ai` returns no CORS headers, so a static page cannot run the OAuth device-code flow
directly. This ~150-line Node server (no dependencies) forwards exactly three endpoints:

| Method | Path (after any mount prefix) | Upstream |
|---|---|---|
| POST | `/oauth2/device/code` | `https://auth.x.ai/oauth2/device/code` |
| POST | `/oauth2/token` | `https://auth.x.ai/oauth2/token` |
| GET  | `/.well-known/openid-configuration` | same on auth.x.ai |

Rules: requests must carry `Origin: https://erik-balfe.github.io` (env `ALLOWED_ORIGINS`), form
bodies only (max 16 KB), only the public Grok CLI `client_id`, only `device_code` /
`refresh_token` grants, 60 req/min per client. Stateless. Logs one metadata line per request
(time, method, route, status, duration) — never bodies, headers or tokens. STT and cleanup do
**not** go through here; the page calls `api.x.ai` directly (it sends CORS headers).

## Deployment (agent-host VPS)

```bash
cd ~/dev/voice-input-web/proxy
docker compose up -d --build            # container xai-auth-proxy on 127.0.0.1:18790, restart unless-stopped
sudo tailscale funnel --bg --https=443 --set-path=/xai-auth http://127.0.0.1:18790
```

Public endpoint: `https://agent-host.tailc5f02e.ts.net/xai-auth/…`
(added as a path on the existing :443 Funnel; `/` → Nextcloud and `:10000` → Navidrome are untouched.
Port 8443 could not be used for Funnel because Nextcloud's docker port is bound to `100.116.42.3:8443`.)

## Undo

```bash
sudo tailscale funnel --https=443 --set-path=/xai-auth off
cd ~/dev/voice-input-web/proxy && docker compose down --rmi all
rm -rf ~/dev/voice-input-web
```

## Local test

```bash
PORT=18999 node server.mjs &
curl -i -X OPTIONS localhost:18999/oauth2/token -H 'Origin: https://erik-balfe.github.io' -H 'Access-Control-Request-Method: POST'
```
