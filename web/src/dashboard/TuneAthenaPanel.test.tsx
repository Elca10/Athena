import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TuneAthenaPanel } from "./TuneAthenaPanel";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
});

test("shows the empty state, then lists preferences once loaded", async () => {
  vi.mocked(api.listPreferences).mockResolvedValue([]);
  render(<TuneAthenaPanel onClose={() => {}} />);

  expect(await screen.findByText("No preferences yet.")).toBeInTheDocument();
});

test("renders existing preferences with a Delete button each", async () => {
  vi.mocked(api.listPreferences).mockResolvedValue([
    { id: "p1", text: "Harder questions on proofs", createdAt: "2026-01-01" },
    { id: "p2", text: "Always give a worked example after a miss", createdAt: "2026-01-02" },
  ]);
  render(<TuneAthenaPanel onClose={() => {}} />);

  expect(await screen.findByText("Harder questions on proofs")).toBeInTheDocument();
  expect(screen.getByText("Always give a worked example after a miss")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
});

test("adds a new preference and refreshes the list", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listPreferences).mockResolvedValueOnce([]).mockResolvedValueOnce([
    { id: "p1", text: "Harder questions on proofs", createdAt: "2026-01-01" },
  ]);
  vi.mocked(api.addPreference).mockResolvedValue({
    id: "p1",
    text: "Harder questions on proofs",
    createdAt: "2026-01-01",
  });
  render(<TuneAthenaPanel onClose={() => {}} />);
  await screen.findByText("No preferences yet.");

  await user.type(screen.getByPlaceholderText(/harder questions on proofs/i), "Harder questions on proofs");
  await user.click(screen.getByRole("button", { name: "Add" }));

  expect(api.addPreference).toHaveBeenCalledWith("Harder questions on proofs");
  expect(await screen.findByText("Harder questions on proofs")).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/harder questions on proofs/i)).toHaveValue("");
});

test("Add is disabled for blank input", async () => {
  vi.mocked(api.listPreferences).mockResolvedValue([]);
  render(<TuneAthenaPanel onClose={() => {}} />);
  await screen.findByText("No preferences yet.");

  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
});

test("shows the server's own error message when adding fails, without clearing the typed text", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listPreferences).mockResolvedValue([]);
  vi.mocked(api.addPreference).mockRejectedValue(new Error("Preference text is too long (limit is 500 characters)"));
  render(<TuneAthenaPanel onClose={() => {}} />);
  await screen.findByText("No preferences yet.");

  await user.type(screen.getByPlaceholderText(/harder questions on proofs/i), "too long");
  await user.click(screen.getByRole("button", { name: "Add" }));

  expect(await screen.findByText("Preference text is too long (limit is 500 characters)")).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/harder questions on proofs/i)).toHaveValue("too long");
});

test("deletes a preference and refreshes the list", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listPreferences)
    .mockResolvedValueOnce([{ id: "p1", text: "Harder questions on proofs", createdAt: "2026-01-01" }])
    .mockResolvedValueOnce([]);
  vi.mocked(api.deletePreference).mockResolvedValue(undefined);
  render(<TuneAthenaPanel onClose={() => {}} />);
  await screen.findByText("Harder questions on proofs");

  await user.click(screen.getByRole("button", { name: "Delete" }));

  expect(api.deletePreference).toHaveBeenCalledWith("p1");
  expect(await screen.findByText("No preferences yet.")).toBeInTheDocument();
});

test("calls onClose when Close is clicked", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.mocked(api.listPreferences).mockResolvedValue([]);
  render(<TuneAthenaPanel onClose={onClose} />);
  await screen.findByText("No preferences yet.");

  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalled();
});
