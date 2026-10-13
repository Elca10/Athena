import { afterEach, beforeEach, expect, test } from "vitest";
import { THEME_STORAGE_KEY, applyTheme, readStoredTheme, storeTheme } from "./theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

test("readStoredTheme defaults to system when nothing is stored", () => {
  expect(readStoredTheme()).toBe("system");
});

test("readStoredTheme defaults to system for a garbage stored value", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "sepia");
  expect(readStoredTheme()).toBe("system");
});

test("readStoredTheme returns a valid stored preference", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "dark");
  expect(readStoredTheme()).toBe("dark");
});

test("storeTheme persists so a later readStoredTheme sees it", () => {
  storeTheme("light");
  expect(readStoredTheme()).toBe("light");
});

test("applyTheme sets data-theme for light/dark and clears it for system", () => {
  applyTheme("dark");
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

  applyTheme("light");
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");

  applyTheme("system");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});
