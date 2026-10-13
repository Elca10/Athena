import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ThemeToggle } from "./ThemeToggle";
import { THEME_STORAGE_KEY } from "./theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

test("defaults to System selected and applies no data-theme override", () => {
  render(<ThemeToggle />);
  expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});

test("picks up a previously stored preference on mount", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "dark");
  render(<ThemeToggle />);
  expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
});

test("clicking Dark sets data-theme, persists it, and marks it selected", async () => {
  const user = userEvent.setup();
  render(<ThemeToggle />);

  await user.click(screen.getByRole("button", { name: "Dark" }));

  expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "false");
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
});

test("clicking back to System clears the data-theme override", async () => {
  const user = userEvent.setup();
  render(<ThemeToggle />);

  await user.click(screen.getByRole("button", { name: "Light" }));
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");

  await user.click(screen.getByRole("button", { name: "System" }));
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
});
