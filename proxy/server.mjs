// Tiny stateless CORS proxy for the xAI device-code OAuth flow.
//
// Why: auth.x.ai sends no CORS headers (tested 2026-10-12), so a static page cannot call
// /oauth2/device/code or /oauth2/token. api.x.ai (STT, Responses) does send CORS headers,
// so audio and text never pass through this proxy.
//
// Forwards ONLY:
//   POST <prefix>/oauth2/device/code  -> https://auth.x.ai/oauth2/device/code
//   POST <prefix>/oauth2/token        -> https://auth.x.ai/oauth2/token
//   GET  <prefix>/.well-known/openid-configuration
// No state, no storage, never logs request or response bodies (they contain tokens).
import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = "https://auth.x.ai";
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "https://erik-balfe.github.io").split(",").map((s) => s.trim()).filter(Boolean),
);
// Only the public Grok CLI client used by voice-input-android / cosmic-scribe.
const ALLOWED_CLIENT_IDS = new Set(
  (process.env.ALLOWED_CLIENT_IDS || "b1a00492-073a-47ea-816f-4c329264a828").split(",").map((s) => s.trim()),
);
const ALLOWED_GRANTS = new Set(["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]);
const MAX_BODY = 16 * 1024;
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 60);

const routes = {
  "/oauth2/device/code": "POST",
  "/oauth2/token": "POST",
  "/.well-known/openid-configuration": "GET",
};

// Very small per-client rate limiter (in memory, cleared every minute).
let hits = new Map();
setInterval(() => { hits = new Map(); }, 60_000).unref();

function log(method, route, status, ms) {
  // Metadata only. Never bodies, headers or query strings.
  console.log(`${new Date().toISOString()} ${method} ${route} ${status} ${ms}ms`);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function send(res, status, headers, body) {
  res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}

function matchRoute(pathname) {
  // Works whether or not the reverse proxy strips the mount path (e.g. /xai-auth).
  for (const r of Object.keys(routes)) if (pathname === r || pathname.endsWith(r)) return r;
  if (pathname === "/healthz" || pathname.endsWith("/healthz")) return "/healthz";
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, "http://local");
  const route = matchRoute(url.pathname);
  const origin = req.headers.origin || "";
  const cors = ALLOWED_ORIGINS.has(origin) ? corsHeaders(origin) : {};
  const done = (status) => log(req.method, route || "?", status, Date.now() - t0);

  if (route === "/healthz") { send(res, 200, { "Content-Type": "text/plain" }, "ok"); return done(200); }
  if (!route) { send(res, 404, cors, ""); return done(404); }
  if (!ALLOWED_ORIGINS.has(origin)) { send(res, 403, {}, "origin not allowed"); return done(403); }

  if (req.method === "OPTIONS") { send(res, 204, cors, ""); return done(204); }
  if (req.method !== routes[route]) { send(res, 405, cors, ""); return done(405); }

  const client = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  const n = (hits.get(client) || 0) + 1;
  hits.set(client, n);
  if (n > RATE_PER_MIN) { send(res, 429, cors, "rate limited"); return done(429); }

  try {
    let upstream;
    if (req.method === "GET") {
      upstream = await fetch(UPSTREAM + route, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    } else {
      const ctype = String(req.headers["content-type"] || "");
      if (!ctype.startsWith("application/x-www-form-urlencoded")) {
        send(res, 415, cors, "form body required"); return done(415);
      }
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      if (!ALLOWED_CLIENT_IDS.has(form.get("client_id") || "")) {
        send(res, 400, { ...cors, "Content-Type": "application/json" }, '{"error":"client_not_allowed"}'); return done(400);
      }
      if (route === "/oauth2/token" && !ALLOWED_GRANTS.has(form.get("grant_type") || "")) {
        send(res, 400, { ...cors, "Content-Type": "application/json" }, '{"error":"grant_not_allowed"}'); return done(400);
      }
      upstream = await fetch(UPSTREAM + route, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form.toString(),
        signal: AbortSignal.timeout(20_000),
      });
    }
    const text = await upstream.text();
    send(res, upstream.status, { ...cors, "Content-Type": upstream.headers.get("content-type") || "application/json" }, text);
    done(upstream.status);
  } catch (e) {
    const status = e && e.message === "too_large" ? 413 : 502;
    send(res, status, { ...cors, "Content-Type": "application/json" }, JSON.stringify({ error: status === 413 ? "too_large" : "upstream_error" }));
    done(status);
  }
});

server.listen(PORT, () => console.log(`xai-auth-proxy listening on :${PORT}; origins=${[...ALLOWED_ORIGINS].join(",")}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
