import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keyboard focus for a modal: moves into it on open (the first field, or
 * the dialog itself), keeps Tab / Shift+Tab cycling inside it, and hands
 * focus back to whatever opened it on close. Without this, Tab walked off
 * into the page behind the backdrop. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const firstField = dialog.querySelector<HTMLElement>("textarea:not([disabled]), input:not([disabled]):not([type=file])");
    (firstField ?? dialog).focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !dialog) return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = dialog.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}
