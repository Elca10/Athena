import { useEffect, useId, useRef, useState } from "react";
import { applyAccent, readStoredAccent, storeAccent } from "./theme";
import { ThemeToggle } from "./ThemeToggle";

// One top-bar button for every look-and-feel choice (issue #13): the
// System/Light/Dark theme and the accent color. A small popover rather
// than a modal, since each change applies live and nothing needs saving.

export const DEFAULT_ACCENT = "#6b3fa0";

const PRESETS: { name: string; hex: string | null }[] = [
  { name: "Purple (default)", hex: null },
  { name: "Blue", hex: "#2563eb" },
  { name: "Teal", hex: "#0f8b8d" },
  { name: "Green", hex: "#2f8a3e" },
  { name: "Orange", hex: "#d9480f" },
  { name: "Pink", hex: "#c2255c" },
];

export function AppearanceMenu() {
  const [open, setOpen] = useState(false);
  const [accent, setAccent] = useState<string | null>(() => readStoredAccent());
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onPointerDown(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  function chooseAccent(hex: string | null) {
    const next = hex === null || hex.toLowerCase() === DEFAULT_ACCENT ? null : hex.toLowerCase();
    setAccent(next);
    storeAccent(next);
    applyAccent(next);
  }

  const isPreset = PRESETS.some((p) => p.hex === accent);

  return (
    <div className="appearance-menu" ref={wrapperRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        Appearance
      </button>
      {open && (
        <div id={panelId} className="appearance-panel" role="dialog" aria-label="Appearance">
          <div className="appearance-section">
            <span className="appearance-label">Theme</span>
            <ThemeToggle />
          </div>
          <div className="appearance-section">
            <span className="appearance-label">Accent color</span>
            <div className="accent-swatches" role="group" aria-label="Accent color">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  className="accent-swatch"
                  style={{ background: preset.hex ?? DEFAULT_ACCENT }}
                  aria-label={preset.name}
                  title={preset.name}
                  aria-pressed={accent === preset.hex}
                  onClick={() => chooseAccent(preset.hex)}
                />
              ))}
            </div>
            <label className={`accent-custom${isPreset ? "" : " accent-custom-active"}`}>
              <input type="color" value={accent ?? DEFAULT_ACCENT} onChange={(e) => chooseAccent(e.target.value)} />
              Custom color
            </label>
          </div>
          <div className="appearance-footer">
            <button type="button" onClick={close}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
