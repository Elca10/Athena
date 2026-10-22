// UI refresh step (a): design tokens + dark mode. This
// module is the single source of truth for reading/writing the user's
// theme preference and applying it to the document, shared by the
// pre-paint inline script in index.html (duplicated there in plain JS
// since it must run before any module loads) and AppearanceMenu.tsx.
// The accent color (issue #13) works the same way: stored per browser,
// applied as inline custom properties that override the CSS defaults in
// both light and dark mode.
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

export const ACCENT_STORAGE_KEY = "athena-accent";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A stored custom accent as lowercase #rrggbb, or null for the default. */
export function readStoredAccent(): string | null {
  try {
    const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (stored && HEX_COLOR.test(stored)) return stored.toLowerCase();
  } catch {
    // Same fallback as readStoredTheme.
  }
  return null;
}

export function storeAccent(hex: string | null): void {
  try {
    if (hex === null) localStorage.removeItem(ACCENT_STORAGE_KEY);
    else localStorage.setItem(ACCENT_STORAGE_KEY, hex);
  } catch {
    // Same as storeTheme.
  }
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black text, whichever reads better on `hex` (WCAG contrast). */
export function contrastTextFor(hex: string): string {
  const l = relativeLuminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (relativeLuminance("#101014") + 0.05);
  return onWhite >= onDark ? "#ffffff" : "#101014";
}

/** Applies a custom accent, or clears it (null) to fall back to the CSS defaults. */
export function applyAccent(hex: string | null): void {
  const style = document.documentElement.style;
  if (hex === null || !HEX_COLOR.test(hex)) {
    style.removeProperty("--accent");
    style.removeProperty("--accent-contrast");
    style.removeProperty("--focus-ring");
    return;
  }
  style.setProperty("--accent", hex);
  style.setProperty("--accent-contrast", contrastTextFor(hex));
  style.setProperty("--focus-ring", hex);
}
