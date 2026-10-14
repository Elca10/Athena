import { useEffect, useRef } from "react";

/** Calls `onEscape` when Escape is pressed, while `enabled`. Every modal
 * uses it, so Escape always means "close this" (and never fires while a
 * modal is mid-action and has disabled it). */
export function useEscapeKey(onEscape: () => void, enabled = true) {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handler.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
