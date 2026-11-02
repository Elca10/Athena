import { useRef } from "react";
import type { Session } from "./api";
import { useEscapeKey } from "../useEscapeKey";
import { useFocusTrap } from "../useFocusTrap";

// Issue #14: look back at a finished session's questions. Read-only, and
// built purely from the session's own `history`: every answered entry
// already carries the question, the user's answer and the answer key
// (Ready: choices/correctIndex/clozeAnswer/modelAnswer/selfGrades; Live
// and Hybrid's model grade: feedback). The answer key is safe to show
// here, since each entry was answered before it reached `history`.

// Every answered entry carries the FSRS rating it produced (Ready's
// auto-grade or self-grade, Live's model grade), so that's the common
// score across modes.
export const RATING_OUTCOME: Record<string, "solid" | "shaky" | "missed"> = {
  easy: "solid",
  good: "solid",
  hard: "shaky",
  again: "missed",
};
export const OUTCOME_LABEL = { solid: "Got it", shaky: "Shaky", missed: "Missed" } as const;

const SELF_GRADE_LABEL: Record<string, string> = { got_it: "Got it", partly: "Partly", missed: "Missed" };

type ReviewEntry = {
  type?: string;
  prompt?: string;
  choices?: string[];
  correctIndex?: number;
  selectedIndex?: number | null;
  clozeAnswer?: string;
  answerText?: string | null;
  modelAnswer?: string;
  rubric?: string[];
  selfGrades?: { status: string }[];
  feedback?: string;
  rating?: string;
};

export function SessionReview({
  session,
  subjectLabel,
  onClose,
}: {
  session: Session;
  subjectLabel: string;
  onClose: () => void;
}) {
  useEscapeKey(onClose, true);
  const dialogRef = useRef<HTMLElement>(null);
  useFocusTrap(dialogRef);
  const entries = session.history as ReviewEntry[];

  return (
    <div className="modal-backdrop">
      <section className="session-review modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="session-review-title">
        <div className="session-review-header">
          <h2 id="session-review-title">{subjectLabel || "Session"}: questions</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {entries.length === 0 && <div className="dashboard-empty">No questions were answered in this session.</div>}
        <ol className="session-review-list">
          {entries.map((entry, i) => (
            <ReviewItem key={i} entry={entry} />
          ))}
        </ol>
      </section>
    </div>
  );
}

function ReviewItem({ entry }: { entry: ReviewEntry }) {
  const outcome = RATING_OUTCOME[entry.rating ?? ""] ?? "shaky";
  return (
    <li className={`session-review-item study-summary-${outcome}`}>
      <div className="session-review-item-head">
        <span className="study-summary-outcome">{OUTCOME_LABEL[outcome]}</span>
        <p className="session-review-prompt">{entry.prompt ?? "Question"}</p>
      </div>
      <ReviewAnswer entry={entry} />
    </li>
  );
}

function ReviewAnswer({ entry }: { entry: ReviewEntry }) {
  if (entry.type === "multiple_choice" && entry.choices?.length) {
    return (
      <ul className="session-review-choices">
        {entry.choices.map((choice, idx) => {
          const tags = [idx === entry.selectedIndex ? "your answer" : null, idx === entry.correctIndex ? "correct" : null].filter(Boolean);
          return (
            <li key={idx} className={idx === entry.correctIndex ? "session-review-correct" : undefined}>
              {choice}
              {tags.length > 0 && <span className="session-review-tag"> ({tags.join(", ")})</span>}
            </li>
          );
        })}
      </ul>
    );
  }

  const correct = entry.type === "cloze" ? entry.clozeAnswer : entry.modelAnswer;
  return (
    <dl className="session-review-fields">
      <dt>Your answer</dt>
      <dd>{entry.answerText?.trim() || "(no answer)"}</dd>
      {correct && (
        <>
          <dt>{entry.type === "cloze" ? "Correct answer" : "Model answer"}</dt>
          <dd>{correct}</dd>
        </>
      )}
      {entry.selfGrades && entry.rubric && entry.rubric.length > 0 && (
        <>
          <dt>Your self-grade</dt>
          <dd>
            <ul className="session-review-rubric">
              {entry.rubric.map((point, idx) => (
                <li key={idx}>
                  {point}: {SELF_GRADE_LABEL[entry.selfGrades?.[idx]?.status ?? ""] ?? "not graded"}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
      {entry.feedback && (
        <>
          <dt>Feedback</dt>
          <dd>{entry.feedback}</dd>
        </>
      )}
    </dl>
  );
}
