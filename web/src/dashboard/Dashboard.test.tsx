import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
});

test("renders the top bar actions and the session columns' empty state", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  render(<Dashboard />);

  expect(screen.getByRole("heading", { name: "Athena" })).toBeInTheDocument();
  for (const label of ["Report a bug", "Tune Athena", "Calendar", "Archive"]) {
    expect(screen.getByRole("button", { name: label })).toBeDisabled();
  }

  for (const label of ["Active", "Waiting", "Completed"]) {
    expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
  }
  expect(screen.getAllByText("Nothing here yet.")).toHaveLength(3);
});

test("shows the empty state once the subjects list resolves to none", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  render(<Dashboard />);

  expect(await screen.findByText("No subjects yet.")).toBeInTheDocument();
});

test("renders a real subject card with its mastery/due/bank-size stats once loaded", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([
    { id: "s1", name: "Organic Chemistry", archived: false, createdAt: "2026-01-01" },
  ]);
  vi.mocked(api.getSubjectSummary).mockResolvedValue({
    masteryCounts: { new: 2, learning: 1, mastered: 3 },
    dueCount: 4,
    bankSize: 10,
  });

  render(<Dashboard />);

  const heading = await screen.findByRole("heading", { name: "Organic Chemistry" });
  const card = heading.closest("article") as HTMLElement;
  expect(within(card).getByText("2 new · 1 learning · 3 mastered")).toBeInTheDocument();
  expect(within(card).getByText("4 due today")).toBeInTheDocument();
  expect(within(card).getByText("10 ready questions")).toBeInTheDocument();
  for (const label of ["Add content", "Study", "Archive"]) {
    expect(within(card).getByRole("button", { name: label })).toBeDisabled();
  }
  expect(api.getSubjectSummary).toHaveBeenCalledWith("s1");
});

test("renders one card per subject, each fetching its own summary", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([
    { id: "s1", name: "Biology", archived: false, createdAt: "2026-01-01" },
    { id: "s2", name: "Calculus", archived: false, createdAt: "2026-01-02" },
  ]);
  vi.mocked(api.getSubjectSummary).mockResolvedValue({
    masteryCounts: { new: 0, learning: 0, mastered: 0 },
    dueCount: 0,
    bankSize: 0,
  });

  render(<Dashboard />);

  expect(await screen.findByRole("heading", { name: "Biology" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Calculus" })).toBeInTheDocument();
  expect(api.getSubjectSummary).toHaveBeenCalledWith("s1");
  expect(api.getSubjectSummary).toHaveBeenCalledWith("s2");
});
