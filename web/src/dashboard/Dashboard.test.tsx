import { render, screen, waitFor, within } from "@testing-library/react";
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
  vi.clearAllMocks();
});

test("renders the top bar actions and the session columns' empty state", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  expect(screen.getByRole("heading", { name: "Athena" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Calendar" })).not.toBeInTheDocument();
  for (const label of ["Report a bug", "Tune Athena", "Archive"]) {
    expect(screen.getByRole("button", { name: label })).toBeEnabled();
  }

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

test("'Check now' re-checks usage on demand and disables itself while in flight", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  const user = userEvent.setup();
  render(<Dashboard />);
  await screen.findByText(/Checking subscription usage…/);
  expect(api.getUsageStatus).toHaveBeenCalledTimes(1);

  let resolveSecondCheck: (value: typeof EMPTY_USAGE) => void = () => {};
  vi.mocked(api.getUsageStatus).mockImplementation(
    () => new Promise((resolve) => (resolveSecondCheck = resolve)),
  );
  const checkNow = screen.getByRole("button", { name: "Check now" });
  await user.click(checkNow);

  expect(await screen.findByRole("button", { name: "Checking…" })).toBeDisabled();
  expect(api.getUsageStatus).toHaveBeenCalledTimes(2);

  // A second click while the first check is still in flight must not fire
  // another overlapping `/usage` call (each can take up to 45s).
  await user.click(screen.getByRole("button", { name: "Checking…" }));
  expect(api.getUsageStatus).toHaveBeenCalledTimes(2);

  resolveSecondCheck(EMPTY_USAGE);
  expect(await screen.findByRole("button", { name: "Check now" })).toBeEnabled();
});

test("polls usage again after a few minutes while the tab stays visible", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.mocked(api.listSubjects).mockResolvedValue([]);
    vi.mocked(api.listSessions).mockResolvedValue([]);
    vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
    mockEmptyUsage();
    render(<Dashboard />);
    await vi.waitFor(() => expect(api.getUsageStatus).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(api.getUsageStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(api.getUsageStatus).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test("does not poll usage while the tab is hidden, and checks again as soon as it's visible", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const visibilitySpy = vi.spyOn(document, "visibilityState", "get");
  try {
    vi.mocked(api.listSubjects).mockResolvedValue([]);
    vi.mocked(api.listSessions).mockResolvedValue([]);
    vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
    mockEmptyUsage();
    render(<Dashboard />);
    await vi.waitFor(() => expect(api.getUsageStatus).toHaveBeenCalledTimes(1));

    visibilitySpy.mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(api.getUsageStatus).toHaveBeenCalledTimes(1);

    visibilitySpy.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(api.getUsageStatus).toHaveBeenCalledTimes(2));
  } finally {
    vi.useRealTimers();
  }
});

test("shows empty-state guidance pointing at the New subject button once the subjects list resolves to none", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  expect(await screen.findByText(/No subjects yet/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New subject" })).toBeEnabled();
});

test("New subject opens a form that creates a subject and refreshes the list", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listSubjects).mockResolvedValueOnce([]).mockResolvedValue([
    { id: "s1", name: "Organic Chemistry", archived: false, createdAt: "2026-01-01" },
  ]);
  vi.mocked(api.getSubjectSummary).mockResolvedValue({
    masteryCounts: { new: 0, learning: 0, mastered: 0 },
    dueCount: 0,
    bankSize: 0,
  });
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  vi.mocked(api.createSubject).mockResolvedValue({ id: "s1", name: "Organic Chemistry", archived: false, createdAt: "2026-01-01" });
  render(<Dashboard />);

  await screen.findByText(/No subjects yet/);
  await user.click(screen.getByRole("button", { name: "New subject" }));

  const nameInput = screen.getByPlaceholderText(/Subject name/);
  const createButton = screen.getByRole("button", { name: "Create" });
  expect(createButton).toBeDisabled();

  await user.type(nameInput, "Organic Chemistry");
  expect(createButton).toBeEnabled();
  await user.click(createButton);

  expect(api.createSubject).toHaveBeenCalledWith("Organic Chemistry");
  expect(await screen.findByRole("heading", { name: "Organic Chemistry" })).toBeInTheDocument();
  expect(screen.queryByPlaceholderText(/Subject name/)).not.toBeInTheDocument();
});

test("New subject form shows the server's error and stays open on failure", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  vi.mocked(api.createSubject).mockRejectedValue(new Error("Subject name cannot be blank."));
  render(<Dashboard />);

  await screen.findByText(/No subjects yet/);
  await user.click(screen.getByRole("button", { name: "New subject" }));
  await user.type(screen.getByPlaceholderText(/Subject name/), "x");
  await user.click(screen.getByRole("button", { name: "Create" }));

  expect(await screen.findByText("Subject name cannot be blank.")).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/Subject name/)).toBeInTheDocument();
});

test("New subject form Cancel closes it without creating anything", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  await screen.findByText(/No subjects yet/);
  await user.click(screen.getByRole("button", { name: "New subject" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByPlaceholderText(/Subject name/)).not.toBeInTheDocument();
  expect(api.createSubject).not.toHaveBeenCalled();
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
  expect(within(card).getByRole("button", { name: "Archive" })).toBeEnabled();
  expect(within(card).getByRole("button", { name: "Study" })).toBeEnabled();
  expect(within(card).getByRole("button", { name: "Add content" })).toBeEnabled();
  expect(api.getSubjectSummary).toHaveBeenCalledWith("s1");
});

test("clicking a subject's Archive button archives it and refreshes", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listSubjects).mockResolvedValue([
    { id: "s1", name: "Organic Chemistry", archived: false, createdAt: "2026-01-01" },
  ]);
  vi.mocked(api.getSubjectSummary).mockResolvedValue({
    masteryCounts: { new: 0, learning: 0, mastered: 0 },
    dueCount: 0,
    bankSize: 0,
  });
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  vi.mocked(api.archiveSubject).mockResolvedValue({
    id: "s1",
    name: "Organic Chemistry",
    archived: true,
    createdAt: "2026-01-01",
  });
  mockEmptyUsage();
  render(<Dashboard />);

  const heading = await screen.findByRole("heading", { name: "Organic Chemistry" });
  const card = heading.closest("article") as HTMLElement;
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  await user.click(within(card).getByRole("button", { name: "Archive" }));

  expect(api.archiveSubject).toHaveBeenCalledWith("s1");
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Organic Chemistry" })).not.toBeInTheDocument());
});

test("clicking Study opens the study flow pre-selecting that subject, and Back to dashboard returns", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listSubjects).mockResolvedValue([
    { id: "s1", name: "Organic Chemistry", archived: false, createdAt: "2026-01-01" },
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

  const heading = await screen.findByRole("heading", { name: "Organic Chemistry" });
  const card = heading.closest("article") as HTMLElement;
  await user.click(within(card).getByRole("button", { name: "Study" }));

  expect(await screen.findByRole("heading", { name: "Study" })).toBeInTheDocument();
  const subjectCheckbox = screen.getByRole("checkbox", { name: "Organic Chemistry" });
  expect(subjectCheckbox).toBeChecked();

  await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
  expect(await screen.findByRole("heading", { name: "Athena" })).toBeInTheDocument();
  expect(api.listSubjects).toHaveBeenCalled();
});

test("clicking Resume on a Waiting session reopens the study flow with that question already up", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listSubjects).mockResolvedValue([
    { id: "s1", name: "Biology", archived: false, createdAt: "2026-01-01" },
  ]);
  vi.mocked(api.getSubjectSummary).mockResolvedValue({
    masteryCounts: { new: 0, learning: 0, mastered: 0 },
    dueCount: 0,
    bankSize: 0,
  });
  vi.mocked(api.listSessions).mockResolvedValue([
    {
      id: "waiting-1",
      subjectIds: ["s1"],
      mode: "ready",
      status: "waiting",
      endedAt: null,
      archived: false,
      currentQuestion: {
        topicId: "t1",
        subjectId: "s1",
        type: "short_answer",
        prompt: "What is the derivative of x^2?",
        difficulty: "medium",
        askedAt: "2026-01-02T00:00:00.000Z",
      },
      history: [],
    },
  ]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  const resumeButton = await screen.findByRole("button", { name: "Resume" });
  await user.click(resumeButton);

  expect(await screen.findByRole("heading", { name: "Study" })).toBeInTheDocument();
  expect(screen.getByText("What is the derivative of x^2?")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
  expect(await screen.findByRole("heading", { name: "Athena" })).toBeInTheDocument();
});

test("an Active session has no Resume button; a reflection-pending Waiting session shows that instead of a prompt", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([
    {
      id: "active-1",
      subjectIds: [],
      mode: "live",
      status: "active",
      endedAt: null,
      archived: false,
      currentQuestion: null,
      history: [],
    },
    {
      id: "waiting-reflection-1",
      subjectIds: [],
      mode: "ready",
      status: "waiting",
      endedAt: null,
      archived: false,
      currentQuestion: null,
      reflectionPending: true,
      history: [],
    },
  ]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  expect(await screen.findByText("Waiting on your end-of-session reflection.")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);
});

test("only a Completed session gets an Archive button, and clicking it archives and refreshes", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  const sessions: api.Session[] = [
    { id: "active-1", subjectIds: [], mode: "live", status: "active", endedAt: null, archived: false, currentQuestion: null, history: [] },
    {
      id: "waiting-1",
      subjectIds: [],
      mode: "ready",
      status: "waiting",
      endedAt: null,
      archived: false,
      currentQuestion: { topicId: "t1", subjectId: "s1", type: "short_answer", prompt: "p", difficulty: "medium", askedAt: "2026-01-01T00:00:00.000Z" },
      history: [],
    },
    { id: "completed-1", subjectIds: [], mode: "live", status: "completed", endedAt: "2026-01-03T00:00:00.000Z", archived: false, currentQuestion: null, history: [{}] },
  ];
  vi.mocked(api.listSessions).mockResolvedValue(sessions);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  vi.mocked(api.archiveSession).mockResolvedValue({ ...sessions[2], archived: true });
  mockEmptyUsage();
  render(<Dashboard />);

  const completedHeading = await screen.findByRole("heading", { name: "Completed" });
  const completedColumn = completedHeading.closest(".dashboard-session-column") as HTMLElement;
  const archiveButton = within(completedColumn).getByRole("button", { name: "Archive" });

  const activeHeading = screen.getByRole("heading", { name: "Active" });
  const activeColumn = activeHeading.closest(".dashboard-session-column") as HTMLElement;
  const waitingHeading = screen.getByRole("heading", { name: "Waiting" });
  const waitingColumn = waitingHeading.closest(".dashboard-session-column") as HTMLElement;
  expect(within(activeColumn).queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  expect(within(waitingColumn).queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();

  vi.mocked(api.listSessions).mockResolvedValue([sessions[0], sessions[1]]);
  await user.click(archiveButton);

  expect(api.archiveSession).toHaveBeenCalledWith("completed-1");
  await waitFor(() => expect(screen.queryByText("1 question answered")).not.toBeInTheDocument());
});

test("clicking Add content opens the panel for that subject, and Done dismisses it", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listSubjects).mockResolvedValue([{ id: "s1", name: "Organic Chemistry", archived: false, createdAt: "2026-01-01" }]);
  vi.mocked(api.getSubjectSummary).mockResolvedValue({
    masteryCounts: { new: 0, learning: 0, mastered: 0 },
    dueCount: 0,
    bankSize: 0,
  });
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  vi.mocked(api.listContent).mockResolvedValue([]);
  mockEmptyUsage();
  render(<Dashboard />);

  await screen.findByRole("heading", { name: "Organic Chemistry" });
  await user.click(screen.getByRole("button", { name: "Add content" }));

  expect(await screen.findByRole("heading", { name: "Add content — Organic Chemistry" })).toBeInTheDocument();
  expect(api.listContent).toHaveBeenCalledWith("s1");

  const panel = screen.getByRole("heading", { name: "Add content — Organic Chemistry" }).closest("section") as HTMLElement;
  await user.click(within(panel).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("heading", { name: "Add content — Organic Chemistry" })).not.toBeInTheDocument();
  expect(api.scanTopics).not.toHaveBeenCalled();
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
      currentQuestion: {
        topicId: "t1",
        subjectId: "s2",
        type: "short_answer",
        prompt: "What is the derivative of x^2?",
        difficulty: "medium",
        askedAt: "2026-01-02T00:00:00.000Z",
      },
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
      currentQuestion: {
        topicId: "t1",
        subjectId: "s1",
        type: "short_answer",
        prompt: longPrompt,
        difficulty: "medium",
        askedAt: "2026-01-02T00:00:00.000Z",
      },
      history: [],
    },
  ]);

  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  expect(await screen.findByText(`${"x".repeat(80)}…`)).toBeInTheDocument();
});

test("Tune Athena button toggles the preferences panel open and closed", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  vi.mocked(api.listPreferences).mockResolvedValue([
    { id: "p1", text: "Harder questions on proofs", createdAt: "2026-01-01" },
  ]);
  render(<Dashboard />);
  await screen.findByRole("heading", { name: "Athena" });

  expect(screen.queryByRole("heading", { name: "Tune Athena" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Tune Athena" }));

  expect(await screen.findByRole("heading", { name: "Tune Athena" })).toBeInTheDocument();
  expect(await screen.findByText("Harder questions on proofs")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("heading", { name: "Tune Athena" })).not.toBeInTheDocument();
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

test("a session of an archived subject is labelled with its name, not 'Unknown subject'", async () => {
  vi.mocked(api.listSubjects).mockResolvedValue([
    { id: "s1", name: "Biology", archived: false, createdAt: "2026-10-01T00:00:00.000Z" },
    { id: "s2", name: "Old Course", archived: true, createdAt: "2026-09-01T00:00:00.000Z" },
  ]);
  vi.mocked(api.getSubjectSummary).mockResolvedValue({ masteryCounts: { new: 0, learning: 0, mastered: 0 }, dueCount: 0, bankSize: 0 });
  vi.mocked(api.listSessions).mockResolvedValue([
    {
      id: "x1",
      subjectIds: ["s2"],
      topicIds: [],
      mode: "ready",
      status: "completed",
      archived: false,
      currentQuestion: null,
      history: [],
      reflectionPending: false,
    } as unknown as api.Session,
  ]);
  vi.mocked(api.getSessionStats).mockResolvedValue(EMPTY_STATS);
  mockEmptyUsage();
  render(<Dashboard />);

  expect(await screen.findByText("Old Course (archived)")).toBeInTheDocument();
  expect(screen.queryByText("Unknown subject")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Biology" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Old Course" })).not.toBeInTheDocument();
  expect(api.listSubjects).toHaveBeenCalledWith({ includeArchived: true });
});
