import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ACCENT_STORAGE_KEY,
  THEME_STORAGE_KEY,
  applyAccent,
  applyTheme,
  contrastTextFor,
  readStoredAccent,
  readStoredTheme,
  storeAccent,
  storeTheme,
} from "./theme";

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

test("readStoredAccent ignores anything that isn't a #rrggbb color", () => {
  expect(readStoredAccent()).toBeNull();
  for (const bad of ["red", "#fff", "#12345g", "#123456; color: red", "url(x)"]) {
    localStorage.setItem(ACCENT_STORAGE_KEY, bad);
    expect(readStoredAccent()).toBeNull();
  }
  localStorage.setItem(ACCENT_STORAGE_KEY, "#2563EB");
  expect(readStoredAccent()).toBe("#2563eb");
});

test("storeAccent(null) clears the stored accent", () => {
  storeAccent("#2563eb");
  storeAccent(null);
  expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
});

test("contrastTextFor picks white on dark accents and near-black on light ones", () => {
  expect(contrastTextFor("#6b3fa0")).toBe("#ffffff");
  expect(contrastTextFor("#2563eb")).toBe("#ffffff");
  expect(contrastTextFor("#ffe066")).toBe("#101014");
  expect(contrastTextFor("#ffffff")).toBe("#101014");
});

test("applyAccent sets the accent properties and null removes them", () => {
  const style = document.documentElement.style;
  applyAccent("#ffe066");
  expect(style.getPropertyValue("--accent")).toBe("#ffe066");
  expect(style.getPropertyValue("--accent-contrast")).toBe("#101014");
  expect(style.getPropertyValue("--focus-ring")).toBe("#ffe066");
  applyAccent(null);
  expect(style.getPropertyValue("--accent")).toBe("");
  expect(style.getPropertyValue("--accent-contrast")).toBe("");
});
