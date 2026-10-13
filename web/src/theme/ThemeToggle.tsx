import { useState } from "react";
import { applyTheme, readStoredTheme, storeTheme, type ThemePreference } from "./theme";

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() => readStoredTheme());

  function choose(next: ThemePreference) {
    setPreference(next);
    storeTheme(next);
    applyTheme(next);
  }

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === preference ? "theme-toggle-active" : undefined}
          aria-pressed={option.value === preference}
          onClick={() => choose(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
