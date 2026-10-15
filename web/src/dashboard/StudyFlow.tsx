import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  archiveSession,
  createSession,
  endSession,
  finishSession,
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
import { ThemeToggle } from "../theme/ThemeToggle";

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
  readingSubjectIds = [],
  banner,
  onExit,
}: {
  subjects: Subject[];
  initialSubjectId?: string;
  resumeSession?: Session | null;
  /** Subjects whose newly added content is still being read in the background. */
  readingSubjectIds?: string[];
  /** Background-work status from the dashboard (reading progress, its result). */
  banner?: ReactNode;
  onExit: () => void;
}) {
  const [session, setSession] = useState<Session | null>(resumeSession ?? null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reflectingId, setReflectingId] = useState<string | null>(null);
  const [reflectingHistory, setReflectingHistory] = useState<unknown[]>([]);
  // Set when nothing is due but there are topics: offers "Review ahead".
  const [nothingDue, setNothingDue] = useState<{ subjectIds: string[]; mode: SessionMode } | null>(null);

  // Stop early: with answers, go to the end-of-session reflection; with
  // none, just close it. Before this, a session could only end by
  // answering every topic, so half-done ones piled up in Waiting.
  async function endEarly() {
    if (!session) return;
    if (!window.confirm("End this session now? Anything you haven't answered yet won't count.")) return;
    try {
      const result = await finishSession(session.id);
      if (result.reflection) {
        setReflectingHistory(result.session?.history ?? []);
        setReflectingId(session.id);
      } else onExit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't end the session.");
    }
  }

  async function start(subjectIds: string[], mode: SessionMode, reviewAhead = false) {
    setStarting(true);
    setError(null);
    setNothingDue(null);
    try {
      setSession(await (reviewAhead ? createSession(subjectIds, mode, { reviewAhead }) : createSession(subjectIds, mode)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start that session.");
      if ((err as { nothingDue?: boolean } | null)?.nothingDue) setNothingDue({ subjectIds, mode });
      setStarting(false);
    }
  }

  // The Ready session being abandoned (its bank was empty) would otherwise
  // linger in the session lists. Close it first; if it never got to ask
  // anything, archive it too, since a "0 questions answered" entry is noise.
  async function switchToLive(abandoned: Session) {
    try {
      await endSession(abandoned.id);
      if (!abandoned.history.length) await archiveSession(abandoned.id);
    } catch {
      // Not worth blocking the switch over; worst case it stays listed.
    }
    await start(abandoned.subjectIds, "live");
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-header-top">
          <h1>Study</h1>
          <div className="dashboard-header-actions">
            <ThemeToggle />
            {session && !reflectingId && (
              <button type="button" onClick={endEarly}>
                End session
              </button>
            )}
            <button type="button" onClick={onExit}>
              Back to dashboard
            </button>
          </div>
        </div>
      </header>
      {banner}
      {error && (
        <div className={nothingDue ? "study-picker-info" : "study-picker-error"}>
          {error}
          {nothingDue && (
            <div className="study-picker-error-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => start(nothingDue.subjectIds, nothingDue.mode, true)}
                disabled={starting}
              >
                Review ahead anyway
              </button>
            </div>
          )}
        </div>
      )}
      {!session && initialSubjectId && (
        <ModePicker
          subjects={subjects}
          initialSubjectId={initialSubjectId}
          readingSubjectIds={readingSubjectIds}
          busy={starting}
          onStart={start}
        />
      )}
      {reflectingId && <ReflectionPrompt sessionId={reflectingId} history={reflectingHistory} onDone={onExit} />}
      {session && !reflectingId && session.mode === "ready" && (
        <ReadySessionScreen session={session} onExit={onExit} onSwitchToLive={() => switchToLive(session)} />
      )}
      {session && !reflectingId && session.mode === "live" && <LiveSessionScreen session={session} onExit={onExit} />}
    </div>
  );
}

function ModePicker({
  subjects,
  initialSubjectId,
  readingSubjectIds,
  busy,
  onStart,
}: {
  subjects: Subject[];
  initialSubjectId: string;
  readingSubjectIds: string[];
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
      {subjects
        .filter((s) => selected.has(s.id) && readingSubjectIds.includes(s.id))
        .map((s) => (
          <p key={s.id} className="study-picker-hint">
            Athena is still reading the content you just added to {s.name}, so its new topics won't be in a session
            started now. You can start anyway with what's already there, or wait a minute.
          </p>
        ))}
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

// "Question 2 of 5". `answered` is true once the shown question is in the
// session's history (its result is on screen), so the count doesn't jump
// ahead before the user clicks Next.
function QuestionProgress({ session, answered }: { session: Session; answered: boolean }) {
  const total = session.topicIds?.length ?? 0;
  if (!total) return null;
  const position = Math.min(total, session.history.length + (answered ? 0 : 1));
  return (
    <span className="study-question-progress">
      Question {position} of {total}
    </span>
  );
}

// Seconds since `active` last became true; null while inactive. Shown on
// the slow model waits so a long one visibly isn't stuck.
function useElapsedSeconds(active: boolean): number | null {
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!active) {
      setSeconds(null);
      return;
    }
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !["radio", "checkbox", "button"].includes(target.type);
  return target.isContentEditable || ["TEXTAREA", "SELECT"].includes(target.tagName);
}

// Keys 1–5 pick the confidence level while it's being asked (not while
// typing an answer, where digits are part of the text).
function useConfidenceKeys(enabled: boolean, onPick: (level: number) => void) {
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const level = Number(e.key);
      if (level >= 1 && level <= 5) {
        // Picking a level moves focus (to Submit); without this the same
        // keystroke could also land wherever focus ends up.
        e.preventDefault();
        onPickRef.current(level);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}

// Enter submits a one-line answer; Ctrl/Cmd+Enter submits a longer one
// (plain Enter stays a new line there).
function submitOnEnter(submit: () => void, multiline: boolean) {
  return (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (multiline && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    submit();
  };
}

// Issue #7: confidence is rated AFTER answering and before any feedback,
// i.e. confidence in the answer just given. That's the order calibration
// research uses (answer, rate, then see the result: the "hypercorrection"
// effect, where confident errors get corrected best). Asking before the
// answer only measured a guess about the topic.
function ConfidencePicker({
  value,
  onPick,
  disabled,
  groupRef,
}: {
  value: number | null;
  onPick: (level: number) => void;
  disabled: boolean;
  groupRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="study-confidence">
      <p>
        How confident are you in your answer? <span className="study-key-hint">(1 = guessing, 5 = certain; or press 1–5)</span>
      </p>
      <div className="study-confidence-options" ref={groupRef}>
        {[1, 2, 3, 4, 5].map((level) => (
          <button
            key={level}
            type="button"
            className={value === level ? "study-confidence-selected" : ""}
            onClick={() => onPick(level)}
            disabled={disabled}
          >
            {level}
          </button>
        ))}
      </div>
    </div>
  );
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
  // A session waiting on its reflection (finished, or ended early) shows
  // the reflection straight away. Fetching a "next question" for it could
  // serve a new question, or run a Live model turn, for a session the user
  // already ended.
  const [ended, setEnded] = useState(initialSession.reflectionPending === true);
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
    if (!activeQuestion && !ended) fetchNext(session.id);
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

  const confidenceRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const hasAnswer = activeQuestion?.type === "multiple_choice" ? selectedIndex !== null : !!answerText.trim();
  function pickConfidence(level: number) {
    setConfidence(level);
    // Next step is Submit; focus it once it's enabled (after this render).
    if (hasAnswer) setTimeout(() => submitRef.current?.focus());
  }
  function submitOrAskConfidence() {
    if (confidence === null) confidenceRef.current?.querySelector("button")?.focus();
    else submitAnswer();
  }
  useConfidenceKeys(!!activeQuestion && !revealed && !lastResult && !busy, pickConfidence);

  if (ended) {
    return <ReflectionPrompt sessionId={session.id} history={session.history} onDone={onExit} />;
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
      {!question && !error && <p>Loading question…</p>}
      {!question && error && (
        <button type="button" className="btn-primary" onClick={() => fetchNext(session.id)} disabled={busy}>
          Try again
        </button>
      )}
      {question && (
        <>
          <div className="study-question">
            <div className="study-question-meta">
              <span className="study-question-difficulty">{question.difficulty}</span>
              <QuestionProgress session={session} answered={!!lastResult} />
            </div>
            <p className="study-question-prompt">{question.prompt}</p>
          </div>

          {!revealed && !lastResult && (
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
                  autoFocus
                  onKeyDown={submitOnEnter(submitOrAskConfidence, false)}
                />
              ) : (
                <textarea
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                  placeholder="Your answer…"
                  rows={4}
                  disabled={busy}
                  autoFocus
                  onKeyDown={submitOnEnter(submitOrAskConfidence, true)}
                />
              )}
              <ConfidencePicker value={confidence} onPick={pickConfidence} disabled={busy} groupRef={confidenceRef} />
              <button
                ref={submitRef}
                type="button"
                className="btn-primary"
                onClick={submitAnswer}
                disabled={
                  busy || confidence === null || (question.type === "multiple_choice" ? selectedIndex === null : !answerText.trim())
                }
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
              <button type="button" className="btn-primary" onClick={() => fetchNext(session.id)} disabled={busy} autoFocus>
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
  // A session waiting on its reflection (finished, or ended early) shows
  // the reflection straight away. Fetching a "next question" for it could
  // serve a new question, or run a Live model turn, for a session the user
  // already ended.
  const [ended, setEnded] = useState(initialSession.reflectionPending === true);

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
    if (!activeQuestion && !ended) fetchNext(session.id);
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

  const confidenceRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  function pickConfidence(level: number) {
    setConfidence(level);
    if (answerText.trim()) setTimeout(() => submitRef.current?.focus());
  }
  function submitOrAskConfidence() {
    if (confidence === null) confidenceRef.current?.querySelector("button")?.focus();
    else submitAnswer();
  }
  useConfidenceKeys(!!activeQuestion && !feedback && !busy, pickConfidence);
  const elapsed = useElapsedSeconds(busy);
  const elapsedLabel = elapsed !== null && elapsed >= 3 ? ` (${elapsed}s)` : "";

  if (ended) {
    return <ReflectionPrompt sessionId={session.id} history={session.history} onDone={onExit} />;
  }

  if (genFailure) {
    return (
      <div className="study-session">
        <p>Athena couldn't get a question from Claude this time. This is usually temporary.</p>
        <p className="study-failure-detail">Details: {genFailure}</p>
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
      {!question && !error && <p>Athena is writing your next question… This can take up to a minute.{elapsedLabel}</p>}
      {!question && error && (
        <button type="button" className="btn-primary" onClick={() => fetchNext(session.id)} disabled={busy}>
          Try again
        </button>
      )}
      {question && (
        <>
          <div className="study-question">
            <div className="study-question-meta">
              <span className="study-question-difficulty">{question.difficulty}</span>
              <QuestionProgress session={session} answered={!!feedback} />
            </div>
            <p className="study-question-prompt">{question.prompt}</p>
          </div>

          {!feedback && (
            <div className="study-answer">
              <textarea
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
                placeholder="Your answer…"
                rows={4}
                disabled={busy}
                autoFocus
                onKeyDown={submitOnEnter(submitOrAskConfidence, true)}
              />
              <ConfidencePicker value={confidence} onPick={pickConfidence} disabled={busy} groupRef={confidenceRef} />
              {busy && <p className="study-working">Athena is grading your answer… This can take up to a minute.{elapsedLabel}</p>}
              {answerFailure && <div className="study-session-error">{answerFailure}</div>}
              <button
                ref={submitRef}
                type="button"
                className="btn-primary"
                onClick={submitAnswer}
                disabled={busy || confidence === null || !answerText.trim()}
              >
                {answerFailure ? "Try again" : "Submit answer"}
              </button>
            </div>
          )}

          {feedback && (
            <div className="study-result">
              <p>{feedback.feedback}</p>
              <button type="button" className="btn-primary" onClick={() => fetchNext(session.id)} disabled={busy} autoFocus>
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
// What happened this session, before the reflection questions. Every
// answered entry carries the FSRS rating it produced (Ready's auto-grade or
// self-grade, Live's model grade), so that's the common score across modes.
const RATING_OUTCOME: Record<string, "solid" | "shaky" | "missed"> = {
  easy: "solid",
  good: "solid",
  hard: "shaky",
  again: "missed",
};
const OUTCOME_LABEL = { solid: "Got it", shaky: "Shaky", missed: "Missed" } as const;

function SessionSummary({ history }: { history: unknown[] }) {
  const entries = history as { prompt?: string; rating?: string }[];
  if (!entries.length) return null;
  const outcomes = entries.map((e) => RATING_OUTCOME[e.rating ?? ""] ?? "shaky");
  const count = (o: string) => outcomes.filter((x) => x === o).length;
  return (
    <div className="study-summary">
      <p className="study-summary-score">
        {entries.length} question{entries.length === 1 ? "" : "s"} answered: {count("solid")} got it · {count("shaky")} shaky ·{" "}
        {count("missed")} missed
      </p>
      <ul className="study-summary-list">
        {entries.map((e, i) => (
          <li key={i} className={`study-summary-${outcomes[i]}`}>
            <span className="study-summary-outcome">{OUTCOME_LABEL[outcomes[i]]}</span>
            <span className="study-summary-prompt">{e.prompt ?? "Question"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReflectionPrompt({ sessionId, history = [], onDone }: { sessionId: string; history?: unknown[]; onDone: () => void }) {
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
      <SessionSummary history={history} />
      <p>{history.length ? "A quick reflection before you go?" : "That's everything due right now. A quick reflection before you go?"}</p>
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
