import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import * as api from "./api";

vi.mock("./api");

const EMPTY_STATS = {
  sessionsThisWeek: 0,
  questionsThisWeek: 0,
  streakDays: 0,
  accuracy: { correct: 0, total: 0, rate: null },
  calibration: { byConfidence: [1, 2, 3, 4, 5].map((confidence) => ({ confidence, total: 0, correctRate: null })) },
};

const EMPTY_USAGE = { fiveHour: null, weekly: null, checkedAt: null, error: null };

function mockEmptyUsage() {
  vi.mocked(api.getUsageStatus).mockResolvedValue(EMPTY_USAGE);
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("renders the top bar actions and the session columns' empty state", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  expect(screen.getByRole("heading", { name: "Athena" })).toBeInTheDocument();
  for (const label of ["Report a bug", "Tune Athena", "Calendar"]) {
    expect(screen.getByRole("button", { name: label })).toBeDisabled();
  }
  expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();

  for (const label of ["Active", "Waiting", "Completed"]) {
    expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
  }
  expect(await screen.findAllByText("Nothing here yet.")).toHaveLength(3);
  expect(await screen.findByText(/no questions answered yet/)).toBeInTheDocument();
  expect(await screen.findByText(/Subscription usage — session: unknown · week: unknown/)).toBeInTheDocument();
});

test("renders real session stats, including the per-confidence calibration breakdown", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue({
    sessionsThisWeek: 3,
    questionsThisWeek: 12,
    streakDays: 4,
    accuracy: { correct: 9, total: 12, rate: 0.75 },
    calibration: {
      byConfidence: [
        { confidence: 1, total: 0, correctRate: null },
        { confidence: 2, total: 2, correctRate: 0.5 },
        { confidence: 3, total: 0, correctRate: null },
        { confidence: 4, total: 0, correctRate: null },
        { confidence: 5, total: 10, correctRate: 0.8 },
      ],
    },
  });
  mockEmptyUsage();
  render(<Dashboard />);

  expect(await screen.findByText(/3 sessions · 12 questions this week · 4-day streak/)).toBeInTheDocument();
  expect(screen.getByText(/75% accuracy \(9\/12\)/)).toBeInTheDocument();
  expect(screen.getByText(/confidence 2 → 50% \(2\)/)).toBeInTheDocument();
  expect(screen.getByText(/confidence 5 → 80% \(10\)/)).toBeInTheDocument();
  expect(screen.queryByText(/confidence 1 →/)).not.toBeInTheDocument();
});

test("renders real subscription usage, including each window's reset time", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  const resetsAt = Math.floor(new Date(2026, 9, 7, 21, 59).getTime() / 1000);
  vi.mocked(api.getUsageStatus).mockResolvedValue({
    fiveHour: { status: "ok", utilization: 0.12, resetsAt },
    weekly: { status: "warning", utilization: 0.91 },
    checkedAt: Date.now(),
    error: null,
  });
  render(<Dashboard />);

  expect(await screen.findByText(/Subscription usage — session: 12% used \(resets/)).toBeInTheDocument();
  expect(screen.getByText(/week: 91% used/)).toBeInTheDocument();
});

test("shows a 'couldn't check' message when the usage check itself failed", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  vi.mocked(api.getUsageStatus).mockResolvedValue({
    fiveHour: null,
    weekly: null,
    checkedAt: Date.now(),
    error: "claude exited with code 1: not logged in",
  });
  render(<Dashboard />);

  expect(await screen.findByText(/Subscription usage — couldn't check\./)).toBeInTheDocument();
});

test("shows the empty state once the subjects list resolves to none", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
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
  vi.mocked(api.listSessions).mockResolvedValue([]);

  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
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
  vi.mocked(api.listSessions).mockResolvedValue([]);

  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  expect(await screen.findByRole("heading", { name: "Biology" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Calculus" })).toBeInTheDocument();
  expect(api.getSubjectSummary).toHaveBeenCalledWith("s1");
  expect(api.getSubjectSummary).toHaveBeenCalledWith("s2");
});

test("sorts real sessions into their Active/Waiting/Completed columns with subject names resolved", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([
    { id: "s1", name: "Biology", archived: false, createdAt: "2026-01-01" },
    { id: "s2", name: "Calculus", archived: false, createdAt: "2026-01-02" },
  ]);
  vi.mocked(api.getSubjectSummary).mockResolvedValue({
    masteryCounts: { new: 0, learning: 0, mastered: 0 },
    dueCount: 0,
    bankSize: 0,
  });
  vi.mocked(api.listSessions).mockResolvedValue([
    {
      id: "active-1",
      subjectIds: ["s1"],
      mode: "live",
      status: "active",
      endedAt: null,
      archived: false,
      currentQuestion: null,
      history: [],
    },
    {
      id: "waiting-1",
      subjectIds: ["s2"],
      mode: "ready",
      status: "waiting",
      endedAt: null,
      archived: false,
      currentQuestion: { prompt: "What is the derivative of x^2?" },
      history: [],
    },
    {
      id: "completed-1",
      subjectIds: ["s1", "s2"],
      mode: "live",
      status: "completed",
      endedAt: "2026-01-03T00:00:00.000Z",
      archived: false,
      currentQuestion: null,
      history: [{}, {}],
    },
  ]);

  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  const activeHeading = await screen.findByRole("heading", { name: "Active" });
  const activeColumn = activeHeading.closest(".dashboard-session-column") as HTMLElement;
  expect(within(activeColumn).getByText("Biology")).toBeInTheDocument();
  expect(within(activeColumn).getByText("Live")).toBeInTheDocument();
  expect(within(activeColumn).getByText("Working…")).toBeInTheDocument();

  const waitingHeading = screen.getByRole("heading", { name: "Waiting" });
  const waitingColumn = waitingHeading.closest(".dashboard-session-column") as HTMLElement;
  expect(within(waitingColumn).getByText("Calculus")).toBeInTheDocument();
  expect(within(waitingColumn).getByText("What is the derivative of x^2?")).toBeInTheDocument();

  const completedHeading = screen.getByRole("heading", { name: "Completed" });
  const completedColumn = completedHeading.closest(".dashboard-session-column") as HTMLElement;
  expect(within(completedColumn).getByText("Biology, Calculus")).toBeInTheDocument();
  expect(within(completedColumn).getByText("2 questions answered")).toBeInTheDocument();
});

test("truncates a long waiting-question prompt preview", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([
    { id: "s1", name: "Biology", archived: false, createdAt: "2026-01-01" },
  ]);
  vi.mocked(api.getSubjectSummary).mockResolvedValue({
    masteryCounts: { new: 0, learning: 0, mastered: 0 },
    dueCount: 0,
    bankSize: 0,
  });
  const longPrompt = "x".repeat(200);
  vi.mocked(api.listSessions).mockResolvedValue([
    {
      id: "waiting-1",
      subjectIds: ["s1"],
      mode: "live",
      status: "waiting",
      endedAt: null,
      archived: false,
      currentQuestion: { prompt: longPrompt },
      history: [],
    },
  ]);

  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  expect(await screen.findByText(`${"x".repeat(80)}…`)).toBeInTheDocument();
});

test("Archive button switches to the Archive view, listing archived subjects and sessions with Restore actions", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listSubjects).mockImplementation(async ({ includeArchived } = {}) =>
    includeArchived
      ? [
          { id: "s1", name: "Biology", archived: false, createdAt: "2026-01-01" },
          { id: "s2", name: "Old Subject", archived: true, createdAt: "2026-01-02" },
        ]
      : [{ id: "s1", name: "Biology", archived: false, createdAt: "2026-01-01" }],
  );
  vi.mocked(api.getSubjectSummary).mockResolvedValue({
    masteryCounts: { new: 0, learning: 0, mastered: 0 },
    dueCount: 0,
    bankSize: 0,
  });
  vi.mocked(api.listSessions).mockImplementation(async ({ includeArchived } = {}) =>
    includeArchived
      ? [
          {
            id: "done-1",
            subjectIds: ["s1"],
            mode: "live",
            status: "completed",
            endedAt: "2026-01-03T00:00:00.000Z",
            archived: true,
            currentQuestion: null,
            history: [],
          },
        ]
      : [],
  );

  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);
  await screen.findByRole("heading", { name: "Biology" });

  const header = screen.getByRole("banner");
  await user.click(within(header).getByRole("button", { name: "Archive" }));

  expect(await screen.findByRole("heading", { name: "Archive" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Archived subjects" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Old Subject" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Biology" })).not.toBeInTheDocument();
  expect(await screen.findByText("Biology")).toBeInTheDocument(); // resolved subject name on the archived session row

  const subjectCard = screen.getByRole("heading", { name: "Old Subject" }).closest("article") as HTMLElement;
  await user.click(within(subjectCard).getByRole("button", { name: "Restore" }));
  expect(api.restoreSubject).toHaveBeenCalledWith("s2");

  await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
  expect(await screen.findByRole("heading", { name: "Athena" })).toBeInTheDocument();
});
