// UI refresh step (a): design tokens + dark mode. This
// module is the single source of truth for reading/writing the user's
// theme preference and applying it to the document, shared by the
// pre-paint inline script in index.html (duplicated there in plain JS
// since it must run before any module loads) and ThemeToggle.tsx.
export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "athena-theme";

export function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // localStorage can throw in locked-down contexts; fall back silently.
  }
  return "system";
}

export function applyTheme(preference: ThemePreference): void {
  if (preference === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", preference);
  }
}

export function storeTheme(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Ignore write failures (private browsing, quota) — the in-memory
    // state still reflects the choice for the rest of this session.
  }
}
