// Theme: "system" (default, follows prefers-color-scheme), "light" or "dark". Stored in localStorage so it applies before first paint.
const KEY = "gv-theme";
const COLORS = { light: "#f2f2f7", dark: "#000000" };
const mq = matchMedia("(prefers-color-scheme: dark)");

export const getThemeMode = () => { try { const t = localStorage.getItem(KEY); return t === "light" || t === "dark" ? t : "system"; } catch (_) { return "system"; } };

function syncThemeColor(mode) {
  const eff = mode === "system" ? (mq.matches ? "dark" : "light") : mode;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (mode === "system") m.removeAttribute("data-forced"); else m.dataset.forced = "1";
    const scheme = (m.getAttribute("media") || "").includes("dark") ? "dark" : "light";
    m.content = mode === "system" ? COLORS[scheme] : COLORS[eff];
  });
}

export function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") root.dataset.theme = mode; else delete root.dataset.theme;
  try { mode === "system" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, mode); } catch (_) {}
  syncThemeColor(mode);
  document.querySelectorAll("[data-theme-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeMode === mode)));
}

export function initTheme() {
  applyTheme(getThemeMode());
  mq.addEventListener?.("change", () => syncThemeColor(getThemeMode()));
  document.querySelectorAll("[data-theme-mode]").forEach((b) => (b.onclick = () => applyTheme(b.dataset.themeMode)));
}
