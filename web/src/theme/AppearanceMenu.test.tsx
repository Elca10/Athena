import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AppearanceMenu } from "./AppearanceMenu";
import { ACCENT_STORAGE_KEY, THEME_STORAGE_KEY } from "./theme";

function reset() {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
}
beforeEach(reset);
afterEach(reset);

const accentVar = () => document.documentElement.style.getPropertyValue("--accent");

test("the panel holds both the theme and accent controls, and Done closes it", async () => {
  const user = userEvent.setup();
  render(<AppearanceMenu />);
  const toggle = screen.getByRole("button", { name: "Appearance" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("dialog")).toBeNull();

  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Accent color" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Purple (default)" })).toHaveAttribute("aria-pressed", "true");

  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(toggle).toHaveFocus();
});

test("Escape and a click outside both close the panel", async () => {
  const user = userEvent.setup();
  render(
    <>
      <AppearanceMenu />
      <p>elsewhere</p>
    </>,
  );
  await user.click(screen.getByRole("button", { name: "Appearance" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Appearance" }));
  await user.click(screen.getByText("elsewhere"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("picking a preset applies and stores it; the default clears it again", async () => {
  const user = userEvent.setup();
  render(<AppearanceMenu />);
  await user.click(screen.getByRole("button", { name: "Appearance" }));

  await user.click(screen.getByRole("button", { name: "Blue" }));
  expect(accentVar()).toBe("#2563eb");
  expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("#2563eb");
  expect(screen.getByRole("button", { name: "Blue" })).toHaveAttribute("aria-pressed", "true");

  await user.click(screen.getByRole("button", { name: "Purple (default)" }));
  expect(accentVar()).toBe("");
  expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
});

test("a custom color from the picker applies, persists and shows as selected", async () => {
  const user = userEvent.setup();
  render(<AppearanceMenu />);
  await user.click(screen.getByRole("button", { name: "Appearance" }));

  fireEvent.change(screen.getByLabelText("Custom color"), { target: { value: "#ffe066" } });
  expect(accentVar()).toBe("#ffe066");
  expect(document.documentElement.style.getPropertyValue("--accent-contrast")).toBe("#101014");
  expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("#ffe066");
  for (const name of ["Purple (default)", "Blue"]) {
    expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
  }
});

test("the theme buttons inside the panel still switch the theme", async () => {
  const user = userEvent.setup();
  render(<AppearanceMenu />);
  await user.click(screen.getByRole("button", { name: "Appearance" }));
  await user.click(screen.getByRole("button", { name: "Dark" }));
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
});
