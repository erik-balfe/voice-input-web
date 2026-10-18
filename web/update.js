// Keeps the installed app on the published version: checks on launch and whenever the app returns to the foreground,
// and reloads itself when it is safe (nothing is being recorded or processed).
const TRY_KEY = "gv-update-try";

async function remoteVersion() {
  // Unique URL + no-store: bypasses the HTTP cache and any stale service-worker entry.
  const res = await fetch(`app.js?check=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return (await res.text()).match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1] || null;
}

async function hardReset() {
  try { (await navigator.serviceWorker?.getRegistrations?.())?.forEach((r) => r.unregister()); } catch (_) {}
  try { for (const k of await caches.keys()) await caches.delete(k); } catch (_) {}
}

/** opts: current, isBusy(), onStatus(text|null), onAvailable(version|null) */
export function createUpdater(opts) {
  let reg = null, checking = null, lastCheck = 0, pending = null;
  const status = (t) => opts.onStatus?.(t);

  async function reload(version) {
    const tried = JSON.parse(sessionStorage.getItem(TRY_KEY) || "{}");
    const n = tried.v === version ? tried.n + 1 : 1;
    sessionStorage.setItem(TRY_KEY, JSON.stringify({ v: version, n }));
    status(`Обновляю до ${version}…`);
    try { await reg?.update(); } catch (_) {}
    if (n >= 2) { await hardReset(); const u = new URL(location.href); u.searchParams.set("_u", String(Date.now())); location.replace(u); return; }
    location.reload();
  }

  async function check({ manual = false } = {}) {
    if (checking) return checking;
    checking = (async () => {
      lastCheck = Date.now();
      let v;
      try { v = await remoteVersion(); } catch (_) { if (manual) status("Не удалось проверить: нет связи"); return null; }
      if (!v) { if (manual) status("Не удалось определить версию"); return null; }
      if (v === opts.current) { sessionStorage.removeItem(TRY_KEY); pending = null; opts.onAvailable?.(null); if (manual) status("Обновлений нет"); return v; }
      const tried = JSON.parse(sessionStorage.getItem(TRY_KEY) || "{}");
      if (tried.v === v && tried.n >= 3) { pending = v; opts.onAvailable?.(v, true); if (manual) status(`Доступна версия ${v}`); return v; }
      if (opts.isBusy()) { pending = v; opts.onAvailable?.(v); return v; }
      await reload(v);
      return v;
    })().finally(() => { checking = null; });
    return checking;
  }

  return {
    async start() {
      if (!("serviceWorker" in navigator)) return;
      try { reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }); } catch (_) {}
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController || sessionStorage.getItem("gv-cc")) return;
        if (opts.isBusy()) { opts.onAvailable?.("new"); return; }
        sessionStorage.setItem("gv-cc", "1"); location.reload();
      });
      check();
      document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastCheck > 30_000) check(); });
    },
    check, // manual or forced
    apply: () => (pending ? reload(pending) : check({ manual: true })),
    flush: () => { if (pending && !opts.isBusy()) check(); },
  };
}
