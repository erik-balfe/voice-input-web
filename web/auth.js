// xAI device-code OAuth (RFC 8628), ported from voice-input-ios XaiAuth.swift /
// voice-input-android XaiOauth.kt. auth.x.ai has no CORS, so calls go through the user's auth proxy
// (secret URL stored in IndexedDB, see proxyBase()).
import { CONFIG } from "./config.js";
import { kv } from "./db.js";

let refreshing = null;
let cancelled = false;

/** Normalize user input: full https URL, or just the secret key/path. Returns "" if invalid. */
export function normalizeProxy(input) {
  let v = String(input || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (u.protocol !== "https:") return "";
      return (u.origin + u.pathname).replace(/\/+$/, "");
    } catch (_) { return ""; }
  }
  v = v.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_-]{16,}$/.test(v)) return "";
  return `https://${CONFIG.defaultProxyHost}/${v}`;
}

export async function proxyBase() { return (await kv.get("proxyBase")) || ""; }

async function postForm(path, fields) {
  const base = await proxyBase();
  if (!base) throw new Error("Сначала вставьте ключ сервера в Настройках");
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });
  let json = {};
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

export function jwtClaims(token) {
  try {
    const p = token.split(".");
    if (p.length !== 3) return null;
    let b = p[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    return JSON.parse(decodeURIComponent(escape(atob(b))));
  } catch (_) {
    return null;
  }
}

const needsRefresh = (access) => {
  const exp = jwtClaims(access)?.exp;
  return typeof exp === "number" && Date.now() / 1000 + CONFIG.refreshSkewSec >= exp;
};

export async function getTokens() { return (await kv.get("tokens")) || null; }
export async function isSignedIn() { return !!(await getTokens())?.access_token; }
export async function logout() { await kv.del("tokens"); }

export async function startDeviceCode() {
  cancelled = false;
  const { status, json } = await postForm("/oauth2/device/code", { client_id: CONFIG.clientId, scope: CONFIG.scope });
  if (status < 200 || status >= 300 || !json.device_code) throw new Error(`Не удалось начать вход (HTTP ${status})`);
  return {
    deviceCode: json.device_code,
    userCode: json.user_code || "?",
    verificationUri: json.verification_uri_complete || json.verification_uri || "https://accounts.x.ai/oauth2/device",
    expiresIn: Math.max(60, Number(json.expires_in) || 1800),
    interval: Math.max(1, Number(json.interval) || 5),
  };
}

export function cancelLogin() { cancelled = true; }

export async function pollDeviceToken(start) {
  let interval = start.interval;
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    if (cancelled) throw new Error("Вход отменён");
    let r;
    try {
      r = await postForm("/oauth2/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CONFIG.clientId,
        device_code: start.deviceCode,
      });
    } catch (_) {
      await sleep(interval * 1000);
      continue;
    }
    if (r.status >= 200 && r.status < 300 && r.json.access_token) {
      await kv.set("tokens", {
        access_token: r.json.access_token,
        refresh_token: r.json.refresh_token || "",
        id_token: r.json.id_token || "",
      });
      return;
    }
    const err = r.json.error || "";
    if (err === "slow_down") interval = Math.min(interval + 1, 30);
    else if (err !== "authorization_pending") throw new Error("Вход не удался: " + (r.json.error_description || err || r.status));
    await sleep(interval * 1000);
  }
  throw new Error("Время ожидания входа истекло");
}

export async function refresh(force = false) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const t = await getTokens();
    if (!t?.refresh_token) throw new Error("Нет сессии xAI — войдите заново");
    if (!force && !needsRefresh(t.access_token)) return t.access_token;
    const { status, json } = await postForm("/oauth2/token", {
      grant_type: "refresh_token",
      client_id: CONFIG.clientId,
      refresh_token: t.refresh_token,
    });
    if (status === 403) throw new Error("OAuth 403 — у аккаунта нет API-доступа через OAuth");
    if (status < 200 || status >= 300 || !json.access_token) {
      if (json.error === "invalid_grant") { await logout(); throw new Error("Сессия истекла — войдите заново"); }
      throw new Error(`Обновление токена: HTTP ${status}`);
    }
    await kv.set("tokens", {
      access_token: json.access_token,
      refresh_token: json.refresh_token || t.refresh_token,
      id_token: json.id_token || t.id_token || "",
    });
    return json.access_token;
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

/** Bearer for api.x.ai: OAuth token (refreshed 1 h before exp) or an optional API key. */
export async function bearer() {
  const mode = (await kv.get("authMode")) || "oauth";
  if (mode === "apikey") {
    const k = await kv.get("apiKey");
    if (!k) throw new Error("Выбран режим API-ключа — вставьте ключ в настройках");
    return k;
  }
  const t = await getTokens();
  if (!t?.access_token) throw new Error("Не выполнен вход — Настройки → Войти через xAI");
  if (!needsRefresh(t.access_token)) return t.access_token;
  if (!t.refresh_token) {
    const exp = jwtClaims(t.access_token)?.exp || 0;
    if (Date.now() / 1000 < exp) return t.access_token;
    throw new Error("Токен истёк — войдите заново");
  }
  return refresh(false);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
