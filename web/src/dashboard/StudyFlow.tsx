import { useEffect, useState } from "react";
import {
  createSession,
  generateNextReadyQuestion,
  submitReadyAnswer,
  submitReadySelfGrade,
  type SelfGradeStatus,
  type Session,
  type Subject,
} from "./api";

// The Study flow (SPEC.md section 4's Study button; section 5's session
// screen). First slice: the mode picker plus a working Ready-mode session
// loop against the already-tested backend routes (routes/sessions.js's
// /ready/question, /ready/answer, /ready/self-grade). Live mode is still
// the disabled "coming soon" option here — its own session screen is a
// later build step, same ship-queue ordering as the backend build that
// landed it first.
//
// A session that runs out of due topics moves to "waiting" with
// `reflectionPending: true` (sessions.js's `promptReflection`) rather than
// completing outright. This slice doesn't build the reflection prompt yet,
// so it just says so and leaves the session sitting in the dashboard's
// Waiting column — a later slice adds resuming a Waiting session back into
// this same screen, which is exactly what that state is for.
export function StudyFlow({
  subjects,
  initialSubjectId,
  onExit,
}: {
  subjects: Subject[];
  initialSubjectId: string;
  onExit: () => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(subjectIds: string[]) {
    setStarting(true);
    setError(null);
    try {
      setSession(await createSession(subjectIds, "ready"));
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
      {!session && (
        <ModePicker subjects={subjects} initialSubjectId={initialSubjectId} busy={starting} onStart={start} />
      )}
      {session && <ReadySessionScreen session={session} />}
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
  onStart: (subjectIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set([initialSubjectId]));

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
          <input type="radio" name="study-mode" checked readOnly />
          Ready — pre-generated questions, graded instantly or self-graded
        </label>
        <label className="study-picker-mode-disabled">
          <input type="radio" name="study-mode" disabled />
          Live (coming soon)
        </label>
      </fieldset>
      <div className="study-picker-actions">
        <button type="button" disabled={busy || selected.size === 0} onClick={() => onStart([...selected])}>
          Start session
        </button>
      </div>
    </div>
  );
}

type RevealedAnswer = { modelAnswer: string; rubric: string[]; misconceptions: string[] };
type LastResult = { kind: "auto"; isCorrect: boolean } | { kind: "self" };

const SELF_GRADE_OPTIONS: { status: SelfGradeStatus; label: string }[] = [
  { status: "got_it", label: "Got it" },
  { status: "partly", label: "Partly" },
  { status: "missed", label: "Missed" },
];

function ReadySessionScreen({ session: initialSession }: { session: Session }) {
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
  const [revealed, setRevealed] = useState<RevealedAnswer | null>(null);
  const [selfGrades, setSelfGrades] = useState<(SelfGradeStatus | null)[]>([]);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [ended, setEnded] = useState(false);
  const [stuck, setStuck] = useState<string | null>(null);

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
        setLastResult({ kind: "auto", isCorrect: result.isCorrect });
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

  if (ended) {
    return (
      <div className="study-session">
        <p>
          That's everything due right now. (The end-of-session reflection prompt is coming soon — this session is
          saved under Waiting until then.)
        </p>
      </div>
    );
  }

  if (stuck) {
    return (
      <div className="study-session">
        <p>{stuck}</p>
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
              <button type="button" onClick={submitSelfGrade} disabled={busy || selfGrades.some((g) => g === null)}>
                Submit self-grade
              </button>
            </div>
          )}

          {lastResult && (
            <div className="study-result">
              <p>
                {lastResult.kind === "auto" ? (lastResult.isCorrect ? "Correct!" : "Not quite.") : "Self-grade recorded."}
              </p>
              <button type="button" onClick={() => fetchNext(session.id)} disabled={busy}>
                Next question
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
