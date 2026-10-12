import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { StudyFlow } from "./StudyFlow";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const SUBJECTS: api.Subject[] = [
  { id: "s1", name: "Biology", archived: false, createdAt: "2026-01-01" },
  { id: "s2", name: "Chemistry", archived: false, createdAt: "2026-01-02" },
];

function baseSession(overrides: Partial<api.Session> = {}): api.Session {
  return {
    id: "sess-1",
    subjectIds: ["s1"],
    mode: "ready",
    status: "active",
    endedAt: null,
    archived: false,
    currentQuestion: null,
    history: [],
    ...overrides,
  };
}

function mcQuestion(overrides: Partial<api.SessionQuestion> = {}): api.SessionQuestion {
  return {
    topicId: "t1",
    subjectId: "s1",
    type: "multiple_choice",
    prompt: "Which organelle produces ATP?",
    difficulty: "intro",
    choices: ["Nucleus", "Mitochondrion", "Ribosome"],
    askedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function freeRecallQuestion(overrides: Partial<api.SessionQuestion> = {}): api.SessionQuestion {
  return {
    topicId: "t2",
    subjectId: "s1",
    type: "free_recall",
    prompt: "Explain photosynthesis in your own words.",
    difficulty: "medium",
    askedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("the mode picker pre-selects the clicked subject and only lets Ready be chosen", async () => {
  vi.mocked(api.createSession).mockResolvedValue(baseSession());
  render(<StudyFlow subjects={SUBJECTS} initialSubjectId="s1" onExit={() => {}} />);

  expect(screen.getByRole("checkbox", { name: "Biology" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Chemistry" })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: /Ready/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /Live/ })).toBeDisabled();
});

test("starting a session creates it with the selected subjects in ready mode and loads the first question", async () => {
  const user = userEvent.setup();
  vi.mocked(api.createSession).mockResolvedValue(baseSession());
  vi.mocked(api.generateNextReadyQuestion).mockResolvedValue({
    ok: true,
    session: baseSession({ currentQuestion: mcQuestion(), status: "waiting" }),
  });
  render(<StudyFlow subjects={SUBJECTS} initialSubjectId="s1" onExit={() => {}} />);

  await user.click(screen.getByRole("checkbox", { name: "Chemistry" }));
  await user.click(screen.getByRole("button", { name: "Start session" }));

  expect(api.createSession).toHaveBeenCalledWith(["s1", "s2"], "ready");
  expect(await screen.findByText("Which organelle produces ATP?")).toBeInTheDocument();
});

test("multiple-choice: confidence must be picked before the answer appears, and a correct pick shows immediate feedback", async () => {
  const user = userEvent.setup();
  vi.mocked(api.createSession).mockResolvedValue(baseSession());
  vi.mocked(api.generateNextReadyQuestion).mockResolvedValueOnce({
    ok: true,
    session: baseSession({ currentQuestion: mcQuestion(), status: "waiting" }),
  });
  vi.mocked(api.submitReadyAnswer).mockResolvedValue({
    ok: true,
    finalized: true,
    isCorrect: true,
    session: baseSession({ status: "active", history: [{}] }),
  });
  render(<StudyFlow subjects={SUBJECTS} initialSubjectId="s1" onExit={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Start session" }));
  await screen.findByText("Which organelle produces ATP?");

  expect(screen.queryByText("Mitochondrion")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "4" }));
  await user.click(screen.getByRole("radio", { name: "Mitochondrion" }));
  await user.click(screen.getByRole("button", { name: "Submit answer" }));

  expect(api.submitReadyAnswer).toHaveBeenCalledWith("sess-1", { confidence: 4, answerText: undefined, selectedIndex: 1 });
  expect(await screen.findByText("Correct!")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next question" })).toBeEnabled();
});

test("free-form: submitting an answer reveals the rubric, and self-grading every point finalizes", async () => {
  const user = userEvent.setup();
  vi.mocked(api.createSession).mockResolvedValue(baseSession());
  vi.mocked(api.generateNextReadyQuestion).mockResolvedValueOnce({
    ok: true,
    session: baseSession({ currentQuestion: freeRecallQuestion(), status: "waiting" }),
  });
  vi.mocked(api.submitReadyAnswer).mockResolvedValue({
    ok: true,
    finalized: false,
    modelAnswer: "Plants convert light energy into chemical energy.",
    rubric: ["Mentions chlorophyll", "Mentions glucose/oxygen output"],
    misconceptions: ["Confusing it with respiration"],
    session: baseSession({ status: "waiting" }),
  });
  vi.mocked(api.submitReadySelfGrade).mockResolvedValue({
    ok: true,
    finalized: true,
    session: baseSession({ status: "active", history: [{}] }),
  });
  render(<StudyFlow subjects={SUBJECTS} initialSubjectId="s1" onExit={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Start session" }));
  await screen.findByText("Explain photosynthesis in your own words.");

  await user.click(screen.getByRole("button", { name: "3" }));
  await user.type(screen.getByPlaceholderText("Your answer…"), "It makes sugar from sunlight.");
  await user.click(screen.getByRole("button", { name: "Submit answer" }));

  expect(api.submitReadyAnswer).toHaveBeenCalledWith("sess-1", {
    confidence: 3,
    answerText: "It makes sugar from sunlight.",
    selectedIndex: undefined,
  });
  expect(await screen.findByText(/Plants convert light energy/)).toBeInTheDocument();

  const submitSelfGrade = screen.getByRole("button", { name: "Submit self-grade" });
  expect(submitSelfGrade).toBeDisabled();

  const gotItButtons = screen.getAllByRole("button", { name: "Got it" });
  await user.click(gotItButtons[0]);
  await user.click(gotItButtons[1]);
  expect(submitSelfGrade).toBeEnabled();
  await user.click(submitSelfGrade);

  expect(api.submitReadySelfGrade).toHaveBeenCalledWith("sess-1", [{ status: "got_it" }, { status: "got_it" }]);
  expect(await screen.findByText("Self-grade recorded.")).toBeInTheDocument();
});

test("clicking Next question fetches and shows the next served question", async () => {
  const user = userEvent.setup();
  vi.mocked(api.createSession).mockResolvedValue(baseSession());
  vi.mocked(api.generateNextReadyQuestion)
    .mockResolvedValueOnce({ ok: true, session: baseSession({ currentQuestion: mcQuestion(), status: "waiting" }) })
    .mockResolvedValueOnce({
      ok: true,
      session: baseSession({
        currentQuestion: mcQuestion({ prompt: "What pigment absorbs light?", topicId: "t3" }),
        status: "waiting",
      }),
    });
  vi.mocked(api.submitReadyAnswer).mockResolvedValue({
    ok: true,
    finalized: true,
    isCorrect: false,
    session: baseSession({ status: "active", history: [{}] }),
  });
  render(<StudyFlow subjects={SUBJECTS} initialSubjectId="s1" onExit={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Start session" }));
  await screen.findByText("Which organelle produces ATP?");

  await user.click(screen.getByRole("button", { name: "2" }));
  await user.click(screen.getByRole("radio", { name: "Nucleus" }));
  await user.click(screen.getByRole("button", { name: "Submit answer" }));
  expect(await screen.findByText("Not quite.")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Next question" }));
  expect(await screen.findByText("What pigment absorbs light?")).toBeInTheDocument();
});

test("shows the no-bank message without crashing when the next topic has nothing to serve yet", async () => {
  const user = userEvent.setup();
  vi.mocked(api.createSession).mockResolvedValue(baseSession());
  vi.mocked(api.generateNextReadyQuestion).mockResolvedValue({
    ok: false,
    noBank: true,
    topicId: "t1",
    reason: 'No bank questions available yet for topic "Cell biology"',
  });
  const onExit = vi.fn();
  render(<StudyFlow subjects={SUBJECTS} initialSubjectId="s1" onExit={onExit} />);
  await user.click(screen.getByRole("button", { name: "Start session" }));

  expect(await screen.findByText(/No bank questions available yet/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
  expect(onExit).toHaveBeenCalled();
});

test("shows the awaiting-reflection message once every due topic has been asked", async () => {
  const user = userEvent.setup();
  vi.mocked(api.createSession).mockResolvedValue(baseSession());
  vi.mocked(api.generateNextReadyQuestion).mockResolvedValue({
    ok: true,
    done: true,
    awaitingReflection: true,
    session: baseSession({ status: "waiting" }),
    bankTopUps: [],
  });
  render(<StudyFlow subjects={SUBJECTS} initialSubjectId="s1" onExit={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Start session" }));

  expect(await screen.findByText(/everything due right now/)).toBeInTheDocument();
  expect(screen.getByText(/reflection prompt is coming soon/)).toBeInTheDocument();
});

test("resuming a session with a question already up skips the mode picker and shows it directly", async () => {
  render(
    <StudyFlow
      subjects={SUBJECTS}
      resumeSession={baseSession({ currentQuestion: mcQuestion(), status: "waiting" })}
      onExit={() => {}}
    />,
  );

  expect(screen.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
  expect(await screen.findByText("Which organelle produces ATP?")).toBeInTheDocument();
  expect(api.generateNextReadyQuestion).not.toHaveBeenCalled();
});

test("resuming a self-graded question with a pending answer reopens straight into the self-grade step", async () => {
  const user = userEvent.setup();
  vi.mocked(api.submitReadySelfGrade).mockResolvedValue({
    ok: true,
    finalized: true,
    session: baseSession({ status: "active", history: [{}] }),
  });
  render(
    <StudyFlow
      subjects={SUBJECTS}
      resumeSession={baseSession({
        status: "waiting",
        currentQuestion: freeRecallQuestion({
          modelAnswer: "Plants convert light energy into chemical energy.",
          rubric: ["Mentions chlorophyll", "Mentions glucose/oxygen output"],
          misconceptions: ["Confusing it with respiration"],
          pendingAnswer: { answerText: "It makes sugar.", confidence: 3, answeredAt: "2026-01-01T00:00:00.000Z" },
        }),
      })}
      onExit={() => {}}
    />,
  );

  expect(await screen.findByText(/Plants convert light energy/)).toBeInTheDocument();
  expect(screen.queryByPlaceholderText("Your answer…")).not.toBeInTheDocument();
  expect(api.generateNextReadyQuestion).not.toHaveBeenCalled();

  const gotItButtons = screen.getAllByRole("button", { name: "Got it" });
  await user.click(gotItButtons[0]);
  await user.click(gotItButtons[1]);
  await user.click(screen.getByRole("button", { name: "Submit self-grade" }));

  expect(api.submitReadySelfGrade).toHaveBeenCalledWith("sess-1", [{ status: "got_it" }, { status: "got_it" }]);
  expect(await screen.findByText("Self-grade recorded.")).toBeInTheDocument();
});

test("resuming a session awaiting reflection shows the same end-of-session message", async () => {
  vi.mocked(api.generateNextReadyQuestion).mockResolvedValue({
    ok: true,
    done: true,
    awaitingReflection: true,
    session: baseSession({ status: "waiting", reflectionPending: true }),
    bankTopUps: [],
  });
  render(
    <StudyFlow
      subjects={SUBJECTS}
      resumeSession={baseSession({ status: "waiting", reflectionPending: true, currentQuestion: null })}
      onExit={() => {}}
    />,
  );

  expect(await screen.findByText(/everything due right now/)).toBeInTheDocument();
});

test("surfaces the server's error message if starting the session fails", async () => {
  const user = userEvent.setup();
  vi.mocked(api.createSession).mockRejectedValue(new Error("subjectIds must be a non-empty array"));
  render(<StudyFlow subjects={SUBJECTS} initialSubjectId="s1" onExit={() => {}} />);

  await user.click(screen.getByRole("button", { name: "Start session" }));
  expect(await screen.findByText("subjectIds must be a non-empty array")).toBeInTheDocument();
});
