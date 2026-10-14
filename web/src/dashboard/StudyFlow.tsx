import { useEffect, useState } from "react";
import {
  createSession,
  generateNextLiveQuestion,
  generateNextReadyQuestion,
  scanBank,
  skipSessionReflection,
  submitLiveAnswer,
  submitReadyAnswer,
  submitReadySelfGrade,
  submitSessionReflection,
  type LiveHistoryEntry,
  type ReflectionAnswers,
  type SelfGradeStatus,
  type Session,
  type SessionMode,
  type SessionQuestion,
  type Subject,
} from "./api";

// The Study flow (SPEC.md section 4's Study button; section 5's session
// screen): the mode picker, Ready mode's bank-backed session loop
// (routes/sessions.js's /ready/question, /ready/answer, /ready/self-grade),
// Live mode's real-time loop (/live/question, /live/answer — each a real
// `claude -p` turn, so costs more of the user's Claude usage; SPEC.md
// section 5 is explicit that's the tradeoff the user is choosing when they
// pick it), and the shared end-of-session reflection prompt.
//
// A session that runs out of due topics moves to "waiting" with
// `reflectionPending: true` (sessions.js's `promptReflection`) rather than
// completing outright, in both modes; each mode's own "ended" state shows
// `ReflectionPrompt` at that point (SPEC.md section 6's four prompts —
// submit or skip, both finalize the session via reflection.js).
//
// `resumeSession`, passed by Dashboard.tsx when the user clicks a Waiting
// session row instead of a subject's Study button, skips the mode picker
// and mounts the matching session screen directly with that session — it
// already carries everything needed (`mode`, `currentQuestion`,
// `reflectionPending`) to pick up exactly where it left off, whether
// that's mid-question, mid-self-grade (Ready only), or just waiting on the
// reflection prompt.
export function StudyFlow({
  subjects,
  initialSubjectId,
  resumeSession,
  onExit,
}: {
  subjects: Subject[];
  initialSubjectId?: string;
  resumeSession?: Session | null;
  onExit: () => void;
}) {
  const [session, setSession] = useState<Session | null>(resumeSession ?? null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(subjectIds: string[], mode: SessionMode) {
    setStarting(true);
    setError(null);
    try {
      setSession(await createSession(subjectIds, mode));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start that session.");
      setStarting(false);
    }
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Study</h1>
        <div className="dashboard-header-actions">
          <button type="button" onClick={onExit}>
            Back to dashboard
          </button>
        </div>
      </header>
      {error && <div className="study-picker-error">{error}</div>}
      {!session && initialSubjectId && (
        <ModePicker subjects={subjects} initialSubjectId={initialSubjectId} busy={starting} onStart={start} />
      )}
      {session && session.mode === "ready" && (
        <ReadySessionScreen session={session} onExit={onExit} onSwitchToLive={() => start(session.subjectIds, "live")} />
      )}
      {session && session.mode === "live" && <LiveSessionScreen session={session} onExit={onExit} />}
    </div>
  );
}

function ModePicker({
  subjects,
  initialSubjectId,
  busy,
  onStart,
}: {
  subjects: Subject[];
  initialSubjectId: string;
  busy: boolean;
  onStart: (subjectIds: string[], mode: SessionMode) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set([initialSubjectId]));
  const [mode, setMode] = useState<SessionMode>("ready");

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="study-picker">
      <fieldset className="study-picker-subjects">
        <legend>Subjects</legend>
        {subjects.map((subject) => (
          <label key={subject.id}>
            <input
              type="checkbox"
              checked={selected.has(subject.id)}
              onChange={() => toggle(subject.id)}
              disabled={busy}
            />
            {subject.name}
          </label>
        ))}
      </fieldset>
      <fieldset className="study-picker-mode">
        <legend>Mode</legend>
        <label>
          <input type="radio" name="study-mode" checked={mode === "ready"} onChange={() => setMode("ready")} disabled={busy} />
          Ready — pre-generated questions, graded instantly or self-graded
        </label>
        <label>
          <input type="radio" name="study-mode" checked={mode === "live"} onChange={() => setMode("live")} disabled={busy} />
          Live — Athena asks and grades in real time (uses more of your Claude usage)
        </label>
      </fieldset>
      <div className="study-picker-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || selected.size === 0}
          onClick={() => onStart([...selected], mode)}
        >
          Start session
        </button>
      </div>
    </div>
  );
}

type RevealedAnswer = { modelAnswer: string; rubric: string[]; misconceptions: string[] };
type LastResult =
  | { kind: "auto"; isCorrect: boolean; correctAnswer: string | null; explanation: string | null }
  | { kind: "self" };

// The explanation only adds something when it isn't just the answer again
// (a bank's modelAnswer for a fill-in is often the bare word).
function explanationFor(correctAnswer: string | null, modelAnswer: string | null): string | null {
  if (!modelAnswer) return null;
  const norm = (s: string) => s.trim().toLowerCase().replace(/[.!]+$/, "");
  return correctAnswer && norm(modelAnswer) === norm(correctAnswer) ? null : modelAnswer;
}

const SELF_GRADE_OPTIONS: { status: SelfGradeStatus; label: string }[] = [
  { status: "got_it", label: "Got it" },
  { status: "partly", label: "Partly" },
  { status: "missed", label: "Missed" },
];

// A resumed session's `currentQuestion` can itself already carry a
// `pendingAnswer` — a self-graded question the user answered before
// closing the tab, still waiting on the self-grade step. api.ts's
// `publicQuestionView`-backed routes keep `modelAnswer`/`rubric`/
// `misconceptions` on exactly that shape, so there's no extra fetch needed
// to resume straight into the reveal screen with them.
function revealedFromPendingAnswer(question: SessionQuestion | null): RevealedAnswer | null {
  if (!question?.pendingAnswer || !question.modelAnswer || !question.rubric) return null;
  return { modelAnswer: question.modelAnswer, rubric: question.rubric, misconceptions: question.misconceptions ?? [] };
}

function ReadySessionScreen({
  session: initialSession,
  onExit,
  onSwitchToLive,
}: {
  session: Session;
  onExit: () => void;
  onSwitchToLive: () => void;
}) {
  const [session, setSession] = useState(initialSession);
  // Deliberately NOT read from `session.currentQuestion` while rendering
  // the answer/reveal/result stages: submitReadyAnswer/submitReadySelfGrade
  // clear it server-side the moment an answer finalizes (sessions.js's
  // `recordAnswer`), but the just-answered question's prompt/rubric still
  // need to stay on screen until the user clicks "Next question".
  const [activeQuestion, setActiveQuestion] = useState(initialSession.currentQuestion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<RevealedAnswer | null>(() =>
    revealedFromPendingAnswer(initialSession.currentQuestion),
  );
  const [selfGrades, setSelfGrades] = useState<(SelfGradeStatus | null)[]>(() => {
    const initialReveal = revealedFromPendingAnswer(initialSession.currentQuestion);
    return initialReveal ? initialReveal.rubric.map(() => null) : [];
  });
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [ended, setEnded] = useState(false);
  const [stuck, setStuck] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  function resetQuestionState() {
    setConfidence(null);
    setAnswerText("");
    setSelectedIndex(null);
    setRevealed(null);
    setSelfGrades([]);
    setLastResult(null);
  }

  async function fetchNext(sessionId: string) {
    setBusy(true);
    setError(null);
    setStuck(null);
    try {
      const result = await generateNextReadyQuestion(sessionId);
      if (!result.ok) {
        setStuck(result.reason);
        return;
      }
      setSession(result.session);
      if (result.done) {
        setEnded(true);
        return;
      }
      setActiveQuestion(result.session.currentQuestion);
      resetQuestionState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the next question.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!activeQuestion) fetchNext(session.id);
    // Runs once per mounted session — `session.id` never changes for the
    // life of this screen, and every later question fetch is triggered by
    // a user action (Next), not this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  async function submitAnswer() {
    const question = activeQuestion;
    if (!question || confidence === null) return;
    if (question.type === "multiple_choice" && selectedIndex === null) return;
    if (question.type !== "multiple_choice" && !answerText.trim()) return;

    setBusy(true);
    setError(null);
    try {
      const result = await submitReadyAnswer(session.id, {
        confidence,
        answerText: question.type === "multiple_choice" ? undefined : answerText,
        selectedIndex: question.type === "multiple_choice" ? selectedIndex ?? undefined : undefined,
      });
      setSession(result.session);
      if (result.finalized) {
        setLastResult({
          kind: "auto",
          isCorrect: result.isCorrect,
          correctAnswer: result.correctAnswer ?? null,
          explanation: explanationFor(result.correctAnswer ?? null, result.modelAnswer ?? null),
        });
      } else {
        setRevealed({ modelAnswer: result.modelAnswer, rubric: result.rubric, misconceptions: result.misconceptions });
        setSelfGrades(result.rubric.map(() => null));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't submit that answer.");
    } finally {
      setBusy(false);
    }
  }

  async function submitSelfGrade() {
    if (selfGrades.some((g) => g === null)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitReadySelfGrade(
        session.id,
        selfGrades.map((status) => ({ status: status as SelfGradeStatus })),
      );
      setSession(result.session);
      setLastResult({ kind: "self" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't submit that self-grade.");
    } finally {
      setBusy(false);
    }
  }

  // SPEC.md section 5's "empty or thin banks": say so and offer Live or
  // "generate now" rather than leaving the session dead-ended.
  // `scanBank`/`scanSubjectForBankGeneration` only ever fills in topics
  // that don't have a bank yet (`bankGeneratedAt` still null) — scanning
  // every subject in the session is simplest and safe to repeat; it's a
  // no-op for a subject whose topics already have one.
  async function generateBankNow() {
    setGenerating(true);
    setGenerateError(null);
    try {
      for (const subjectId of session.subjectIds) {
        await scanBank(subjectId);
      }
      await fetchNext(session.id);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Couldn't generate the question bank.");
    } finally {
      setGenerating(false);
    }
  }

  if (ended) {
    return <ReflectionPrompt sessionId={session.id} onDone={onExit} />;
  }

  if (stuck) {
    return (
      <div className="study-session">
        <p>{stuck}</p>
        {generateError && <div className="study-session-error">{generateError}</div>}
        <div className="study-session-actions">
          <button type="button" className="btn-primary" onClick={generateBankNow} disabled={generating}>
            {generating ? "Generating…" : "Generate question bank now"}
          </button>
          <button type="button" className="btn-secondary" onClick={onSwitchToLive} disabled={generating}>
            Switch to Live instead
          </button>
        </div>
      </div>
    );
  }

  const question = activeQuestion;

  return (
    <div className="study-session">
      {error && <div className="study-session-error">{error}</div>}
      {!question && <p>Loading question…</p>}
      {question && (
        <>
          <div className="study-question">
            <span className="study-question-difficulty">{question.difficulty}</span>
            <p className="study-question-prompt">{question.prompt}</p>
          </div>

          {!revealed && !lastResult && (
            <div className="study-confidence">
              <p>How confident are you, before answering?</p>
              <div className="study-confidence-options">
                {[1, 2, 3, 4, 5].map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={confidence === level ? "study-confidence-selected" : ""}
                    onClick={() => setConfidence(level)}
                    disabled={busy}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!revealed && !lastResult && confidence !== null && (
            <div className="study-answer">
              {question.type === "multiple_choice" ? (
                <div className="study-answer-choices">
                  {(question.choices ?? []).map((choice, idx) => (
                    <label key={idx}>
                      <input
                        type="radio"
                        name="study-answer-choice"
                        checked={selectedIndex === idx}
                        onChange={() => setSelectedIndex(idx)}
                        disabled={busy}
                      />
                      {choice}
                    </label>
                  ))}
                </div>
              ) : question.type === "cloze" ? (
                <input
                  type="text"
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                  placeholder="Fill in the blank…"
                  disabled={busy}
                />
              ) : (
                <textarea
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                  placeholder="Your answer…"
                  rows={4}
                  disabled={busy}
                />
              )}
              <button
                type="button"
                className="btn-primary"
                onClick={submitAnswer}
                disabled={busy || (question.type === "multiple_choice" ? selectedIndex === null : !answerText.trim())}
              >
                Submit answer
              </button>
            </div>
          )}

          {revealed && !lastResult && (
            <div className="study-reveal">
              <p className="study-reveal-answer">
                <strong>Model answer:</strong> {revealed.modelAnswer}
              </p>
              <ul className="study-reveal-rubric">
                {revealed.rubric.map((point, idx) => (
                  <li key={idx}>
                    <span>{point}</span>
                    <div className="study-reveal-rubric-options">
                      {SELF_GRADE_OPTIONS.map(({ status, label }) => (
                        <button
                          key={status}
                          type="button"
                          className={selfGrades[idx] === status ? "study-reveal-selected" : ""}
                          onClick={() => setSelfGrades((prev) => prev.map((g, i) => (i === idx ? status : g)))}
                          disabled={busy}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              {revealed.misconceptions.length > 0 && (
                <p className="study-reveal-misconceptions">Common mix-ups: {revealed.misconceptions.join("; ")}</p>
              )}
              <button
                type="button"
                className="btn-primary"
                onClick={submitSelfGrade}
                disabled={busy || selfGrades.some((g) => g === null)}
              >
                Submit self-grade
              </button>
            </div>
          )}

          {lastResult && (
            <div className="study-result">
              <p className="study-result-verdict">
                {lastResult.kind === "auto" ? (lastResult.isCorrect ? "Correct!" : "Not quite.") : "Self-grade recorded."}
              </p>
              {lastResult.kind === "auto" && !lastResult.isCorrect && lastResult.correctAnswer && (
                <p className="study-result-answer">
                  The answer: <strong>{lastResult.correctAnswer}</strong>
                </p>
              )}
              {lastResult.kind === "auto" && lastResult.explanation && (
                <p className="study-result-explanation">{lastResult.explanation}</p>
              )}
              <button type="button" className="btn-primary" onClick={() => fetchNext(session.id)} disabled={busy}>
                Next question
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type LiveFeedback = { feedback: string; rating: string };

// Live mode (SPEC.md section 5): every question is one of the free-form
// types (liveSession.js never generates multiple_choice/cloze — those need
// a stored answer key this module doesn't have), so there's no
// choices/self-grade branching the way Ready needs. Grading is a single
// real-time model turn that returns feedback + an FSRS rating directly
// (liveSession.js's `submitLiveAnswer`), not a separate reveal-then-self-
// grade step — the just-graded entry lands in `session.history`, so that's
// where the feedback to show comes from, not a dedicated response field.
// Both `/live/question` and `/live/answer` can fail with a real, retryable
// `{ok: false, reason}` (a model-call or unparseable-reply failure) that
// leaves the session/topic untouched — shown with a "Try again" button
// rather than being treated like a thrown error, same posture the server
// module itself documents.
function LiveSessionScreen({ session: initialSession, onExit }: { session: Session; onExit: () => void }) {
  const [session, setSession] = useState(initialSession);
  const [activeQuestion, setActiveQuestion] = useState(initialSession.currentQuestion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [genFailure, setGenFailure] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [answerFailure, setAnswerFailure] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<LiveFeedback | null>(null);
  const [ended, setEnded] = useState(false);

  async function fetchNext(sessionId: string) {
    setBusy(true);
    setError(null);
    setGenFailure(null);
    try {
      const result = await generateNextLiveQuestion(sessionId);
      if (!result.ok) {
        setGenFailure(result.reason);
        return;
      }
      setSession(result.session);
      if (result.done) {
        setEnded(true);
        return;
      }
      setActiveQuestion(result.session.currentQuestion);
      setConfidence(null);
      setAnswerText("");
      setAnswerFailure(null);
      setFeedback(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the next question.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!activeQuestion) fetchNext(session.id);
    // Same "runs once per mounted session" reasoning as ReadySessionScreen's
    // identical effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  async function submitAnswer() {
    if (!activeQuestion || confidence === null || !answerText.trim()) return;
    setBusy(true);
    setError(null);
    setAnswerFailure(null);
    try {
      const result = await submitLiveAnswer(session.id, { answerText, confidence });
      if (!result.ok) {
        setAnswerFailure(result.reason);
        return;
      }
      setSession(result.session);
      const last = result.session.history[result.session.history.length - 1] as LiveHistoryEntry;
      setFeedback({ feedback: last.feedback, rating: last.rating });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't submit that answer.");
    } finally {
      setBusy(false);
    }
  }

  if (ended) {
    return <ReflectionPrompt sessionId={session.id} onDone={onExit} />;
  }

  if (genFailure) {
    return (
      <div className="study-session">
        <p>{genFailure}</p>
        <button type="button" className="btn-primary" onClick={() => fetchNext(session.id)} disabled={busy}>
          Try again
        </button>
      </div>
    );
  }

  const question = activeQuestion;

  return (
    <div className="study-session">
      {error && <div className="study-session-error">{error}</div>}
      {!question && <p>Loading question…</p>}
      {question && (
        <>
          <div className="study-question">
            <span className="study-question-difficulty">{question.difficulty}</span>
            <p className="study-question-prompt">{question.prompt}</p>
          </div>

          {!feedback && (
            <div className="study-confidence">
              <p>How confident are you, before answering?</p>
              <div className="study-confidence-options">
                {[1, 2, 3, 4, 5].map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={confidence === level ? "study-confidence-selected" : ""}
                    onClick={() => setConfidence(level)}
                    disabled={busy}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!feedback && confidence !== null && (
            <div className="study-answer">
              <textarea
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
                placeholder="Your answer…"
                rows={4}
                disabled={busy}
              />
              {answerFailure && <div className="study-session-error">{answerFailure}</div>}
              <button type="button" className="btn-primary" onClick={submitAnswer} disabled={busy || !answerText.trim()}>
                {answerFailure ? "Try again" : "Submit answer"}
              </button>
            </div>
          )}

          {feedback && (
            <div className="study-result">
              <p>{feedback.feedback}</p>
              <button type="button" className="btn-primary" onClick={() => fetchNext(session.id)} disabled={busy}>
                Next question
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// SPEC.md section 6's four end-of-session prompts, in the order given
// there — mirrors reflection.js's REFLECTION_FIELDS exactly.
const REFLECTION_PROMPTS: { field: keyof ReflectionAnswers; label: string }[] = [
  { field: "learned", label: "What did you learn?" },
  { field: "surprised", label: "What surprised you?" },
  { field: "connects", label: "What does this connect to?" },
  { field: "differently", label: "What will you do differently?" },
];

// Every field is optional, but `submitSessionReflection` throws if all of
// them come back blank (reflection.js: that's what Skip is for) — Submit
// stays disabled until at least one has real content, so the user gets
// that feedback before the round trip rather than from a server error.
function ReflectionPrompt({ sessionId, onDone }: { sessionId: string; onDone: () => void }) {
  const [answers, setAnswers] = useState<ReflectionAnswers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasAnyAnswer = REFLECTION_PROMPTS.some(({ field }) => (answers[field] ?? "").trim());

  function setField(field: keyof ReflectionAnswers, value: string) {
    setAnswers((prev) => ({ ...prev, [field]: value }));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await submitSessionReflection(sessionId, answers);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that reflection.");
      setBusy(false);
    }
  }

  async function skip() {
    setBusy(true);
    setError(null);
    try {
      await skipSessionReflection(sessionId);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't skip the reflection.");
      setBusy(false);
    }
  }

  return (
    <div className="study-session study-reflection">
      <p>That's everything due right now. A quick reflection before you go?</p>
      {error && <div className="study-session-error">{error}</div>}
      {REFLECTION_PROMPTS.map(({ field, label }) => (
        <label key={field} className="study-reflection-field">
          {label}
          <textarea
            value={answers[field] ?? ""}
            onChange={(e) => setField(field, e.target.value)}
            rows={2}
            disabled={busy}
          />
        </label>
      ))}
      <div className="study-reflection-actions">
        <button type="button" className="btn-primary" onClick={submit} disabled={busy || !hasAnyAnswer}>
          Submit reflection
        </button>
        <button type="button" className="btn-secondary" onClick={skip} disabled={busy}>
          Skip
        </button>
      </div>
    </div>
  );
}
