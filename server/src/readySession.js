// Ready mode's session flow (SPEC.md section 5: "uses pre-generated
// questions, model answers and rubrics from the subject's question bank
// ... grading is done without a model call wherever possible"). Unlike
// `liveSession.js`, nothing here ever shells out to `claude -p` — every
// question comes from `questionBank.js`'s existing storage and every
// grading decision is deterministic code (section 6: "the scheduler and
// session builder must be deterministic code, not model calls").
//
// Mirrors liveSession.js's shape where it still applies: `pickNextTopicId`
// (imported from there — both modes ask about a session's `topicIds` in
// order, one question per topic, until every topic has a `history` entry)
// decides which topic is next and ends the session once none remain.
//
// Multiple choice and cloze are auto-graded immediately from the bank
// question's own answer-key fields (correctIndex/clozeAnswer) — one HTTP
// call in, one finalized answer out, same shape as Live's /live/answer.
//
// The five free-form types have no answer key to auto-grade against —
// section 5: "the user answers first, then sees the model answer and
// rubric points and self-grades (each key point: got it/partly/missed)".
// That's two separate user actions (answer, then self-grade), so it needs
// two calls: `submitReadyAnswer` stashes the answer+confidence
// (sessions.js's `recordPendingAnswer`, status stays "waiting") and reveals
// the model answer/rubric/misconceptions already sitting on
// `currentQuestion` — no second bank lookup needed, and no model call
// either, since storing the full bank-question snapshot on
// `currentQuestion` when the question is served means grading never races
// a bank question being changed or topped up in between. `submitReadySelfGrade`
// then maps the per-point self-grade to an FSRS rating and finalizes
// through `recordAnswer`, same as Live.
//
// A served question's answer-key fields (modelAnswer, rubric,
// misconceptions, correctIndex, clozeAnswer) ARE stored on
// `currentQuestion` right away for that reason, but must never reach the
// client in the initial "here's your question" response — `publicQuestionView`
// is the scrubbed shape routes/sessions.js sends for that one response;
// every other response here is correctly post-answer and returns the full
// thing.

import { getSession, setCurrentQuestion, recordPendingAnswer, recordAnswer, endSession } from "./sessions.js";
import { getTopicById, recordTopicReview } from "./topics.js";
import { listBankQuestions, markQuestionShown } from "./questionBank.js";
import { pickNextTopicId } from "./liveSession.js";

/** The two bank question types with a real local answer key — SPEC.md
 * section 5: "Multiple choice, cloze and numeric: auto-graded locally."
 * (No "numeric" type exists in questionBank.js's QUESTION_TYPES yet — bank
 * generation never produces one — so there's nothing to auto-grade there
 * until that type exists.) Every other type is self-graded against a
 * rubric instead. */
export const AUTO_GRADED_TYPES = ["multiple_choice", "cloze"];

export const SELF_GRADE_STATUSES = ["got_it", "partly", "missed"];

/**
 * Picks which of a topic's bank questions to serve next: never-shown
 * questions first, then the one shown longest ago — SPEC.md section 5's
 * "not reused verbatim too soon". Returns `null` for an empty bank (the
 * "empty or thin bank" case the section also names). Pure, exported for
 * its own test.
 */
export function pickBankQuestion(questions) {
  if (!questions.length) return null;
  return questions.slice().sort((a, b) => {
    if (a.seenCount !== b.seenCount) return a.seenCount - b.seenCount;
    const aShown = a.lastShownAt ? Date.parse(a.lastShownAt) : -Infinity;
    const bShown = b.lastShownAt ? Date.parse(b.lastShownAt) : -Infinity;
    return aShown - bShown;
  })[0];
}

/**
 * Strips a served question's answer-key fields before it reaches the
 * client — `choices` (the option text for multiple_choice) stays, since
 * the user needs it to answer; `correctIndex`, `clozeAnswer`, `modelAnswer`,
 * `rubric`, and `misconceptions` do not. Pure, exported for its own test.
 */
export function publicQuestionView(question) {
  const { modelAnswer, rubric, misconceptions, correctIndex, clozeAnswer, ...rest } = question;
  return rest;
}

/**
 * Compares a user's answer to a bank question's own answer key.
 * `question.type` must be one of `AUTO_GRADED_TYPES`. Cloze comparison is
 * trimmed and case-insensitive. Pure, exported for its own test.
 */
export function gradeAutoGradedAnswer(question, { selectedIndex, answerText } = {}) {
  if (question.type === "multiple_choice") {
    return Number.isInteger(selectedIndex) && selectedIndex === question.correctIndex;
  }
  if (question.type === "cloze") {
    const normalize = (s) => String(s ?? "").trim().toLowerCase();
    return normalize(answerText) === normalize(question.clozeAnswer);
  }
  throw new Error(`gradeAutoGradedAnswer only applies to ${AUTO_GRADED_TYPES.join("/")}: ${question.type}`);
}

/**
 * No partial credit exists locally for an auto-graded answer the way a
 * model's judgment (Live mode) or a human's own self-grade (the free-form
 * path below) can express — "hard"/"easy" are reserved for that richer
 * judgment. A correct auto-graded answer is "good", a wrong one is
 * "again". Ada's call, section 11-style (SPEC.md doesn't give an exact
 * mapping).
 */
export function mapAutoGradeToRating(isCorrect) {
  return isCorrect ? "good" : "again";
}

/**
 * Deterministic (section 6: scheduler decisions must be code, not a model
 * call) FSRS-rating mapping from a user's own per-rubric-point self-grade.
 * Any "missed" point means "again"; short of that, any "partly" means
 * "hard"; all "got it" means "good". "easy" is never reached by
 * self-grading — reserved for Live mode's model judgment, which can
 * recognize an answer as exceptional in a way a flat per-point checklist
 * can't. Pure, exported for its own test.
 */
export function mapSelfGradeToRating(selfGrades) {
  if (selfGrades.some((g) => g.status === "missed")) return "again";
  if (selfGrades.some((g) => g.status === "partly")) return "hard";
  return "good";
}

/**
 * Serves a Ready session's next question: `pickNextTopicId` decides which
 * due topic (if any) is next, same interleaving-order logic Live mode
 * uses; `pickBankQuestion` picks the least-recently-shown bank question for
 * it. Once every topic's been asked, the session ends itself, mirroring
 * `generateNextLiveQuestion`'s `{ok: true, done: true, session}` shape
 * exactly. An empty/not-yet-generated bank for the next topic (SPEC.md
 * section 5's "empty or thin bank") is a real, recoverable outcome, not a
 * caller mistake — it comes back as `{ok: false, noBank: true, topicId,
 * reason}` with the session untouched, same posture `generateNextLiveQuestion`
 * gives a model-call failure, so a retry after generating a bank (or the
 * caller choosing Live instead, per the spec) doesn't need any cleanup.
 * Validation errors (bad session id, wrong mode, a question already
 * served, no topics at all) throw, same as Live.
 */
export async function generateNextReadyQuestion(appDataDir, sessionId) {
  const session = await getSession(appDataDir, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.mode !== "ready") throw new Error(`generateNextReadyQuestion only applies to ready-mode sessions: ${sessionId}`);
  if (session.currentQuestion) throw new Error(`Session already has a current question: ${sessionId}`);
  if (!session.topicIds.length) throw new Error(`Session has no topics to ask about: ${sessionId}`);

  const topicId = pickNextTopicId(session.topicIds, session.history);
  if (topicId === null) {
    const ended = await endSession(appDataDir, sessionId);
    return { ok: true, done: true, session: ended };
  }
  const topic = await getTopicById(appDataDir, topicId);
  if (!topic) throw new Error(`Topic not found: ${topicId}`);

  const bankQuestions = await listBankQuestions(appDataDir, topicId);
  const picked = pickBankQuestion(bankQuestions);
  if (!picked) {
    return { ok: false, noBank: true, topicId, reason: `No bank questions available yet for topic "${topic.name}"` };
  }
  await markQuestionShown(appDataDir, picked.id);

  const question = {
    bankQuestionId: picked.id,
    topicId: topic.id,
    subjectId: topic.subjectId,
    type: picked.type,
    prompt: picked.prompt,
    difficulty: picked.difficulty,
    modelAnswer: picked.modelAnswer,
    rubric: picked.rubric,
    misconceptions: picked.misconceptions,
    ...(picked.type === "multiple_choice" ? { choices: picked.choices, correctIndex: picked.correctIndex } : {}),
    ...(picked.type === "cloze" ? { clozeAnswer: picked.clozeAnswer } : {}),
    askedAt: new Date().toISOString(),
  };
  const updated = await setCurrentQuestion(appDataDir, sessionId, question);
  return { ok: true, session: updated };
}

/**
 * Submits the user's answer to a Ready session's current question.
 * Multiple choice/cloze grade and finalize immediately (same shape as
 * Live's `submitLiveAnswer`: FSRS rating applied, answer appended to
 * `history`, session back to "active") and the response's `isCorrect`
 * reveals the right answer now, correctly, since grading is already done.
 * Every other type can't finalize yet — section 5's self-grade step still
 * needs to happen — so the answer+confidence is stashed via
 * `recordPendingAnswer` (session stays "waiting") and the response reveals
 * `modelAnswer`/`rubric`/`misconceptions` for the client to show next.
 * Validation errors (bad session id, wrong mode, no current question, an
 * already-pending answer, a malformed confidence/answer) throw — caller
 * mistakes, not a recoverable outcome, since no model call is ever
 * involved here to fail.
 */
export async function submitReadyAnswer(appDataDir, sessionId, { answerText, selectedIndex, confidence } = {}) {
  const session = await getSession(appDataDir, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.mode !== "ready") throw new Error(`submitReadyAnswer only applies to ready-mode sessions: ${sessionId}`);
  if (!session.currentQuestion) throw new Error(`Session has no current question to answer: ${sessionId}`);
  if (session.currentQuestion.pendingAnswer) {
    throw new Error(`Session's current question already has a pending answer awaiting self-grade: ${sessionId}`);
  }
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    throw new Error("confidence must be an integer from 1 to 5");
  }

  const question = session.currentQuestion;

  if (AUTO_GRADED_TYPES.includes(question.type)) {
    const trimmedAnswer = typeof answerText === "string" ? answerText.trim() : "";
    if (question.type === "cloze" && !trimmedAnswer) throw new Error("answerText must be a non-empty string");
    if (question.type === "multiple_choice" && !Number.isInteger(selectedIndex)) {
      throw new Error("selectedIndex must be an integer");
    }
    const isCorrect = gradeAutoGradedAnswer(question, { selectedIndex, answerText: trimmedAnswer });
    const rating = mapAutoGradeToRating(isCorrect);
    await recordTopicReview(appDataDir, question.topicId, rating);
    const entry = {
      ...question,
      answerText: question.type === "cloze" ? trimmedAnswer : null,
      selectedIndex: question.type === "multiple_choice" ? selectedIndex : null,
      confidence,
      rating,
      isCorrect,
      answeredAt: new Date().toISOString(),
    };
    const updated = await recordAnswer(appDataDir, sessionId, entry);
    return { ok: true, finalized: true, isCorrect, session: updated };
  }

  const trimmedAnswer = typeof answerText === "string" ? answerText.trim() : "";
  if (!trimmedAnswer) throw new Error("answerText must be a non-empty string");
  const updated = await recordPendingAnswer(appDataDir, sessionId, {
    answerText: trimmedAnswer,
    confidence,
    answeredAt: new Date().toISOString(),
  });
  return {
    ok: true,
    finalized: false,
    modelAnswer: question.modelAnswer,
    rubric: question.rubric,
    misconceptions: question.misconceptions,
    session: updated,
  };
}

/**
 * Finishes a self-graded Ready question once the user has rated each
 * rubric point (SPEC.md section 5). Requires `submitReadyAnswer` to have
 * already stashed a pending answer on the current question. Maps the
 * self-grade to an FSRS rating (`mapSelfGradeToRating`), applies it, and
 * finalizes through `recordAnswer` exactly like the auto-graded path and
 * Live mode both do. Validation errors (bad session id, wrong mode, no
 * current question, no pending answer yet, a malformed `selfGrades`) all
 * throw — caller mistakes, no model call involved to fail instead.
 */
export async function submitReadySelfGrade(appDataDir, sessionId, { selfGrades } = {}) {
  const session = await getSession(appDataDir, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.mode !== "ready") throw new Error(`submitReadySelfGrade only applies to ready-mode sessions: ${sessionId}`);
  const question = session.currentQuestion;
  if (!question) throw new Error(`Session has no current question to self-grade: ${sessionId}`);
  if (!question.pendingAnswer) throw new Error(`Session's current question has no pending answer to self-grade yet: ${sessionId}`);

  const expectedCount = question.rubric?.length ?? 0;
  if (!Array.isArray(selfGrades) || selfGrades.length !== expectedCount || selfGrades.length === 0) {
    throw new Error(`selfGrades must have exactly ${expectedCount} entries, one per rubric point`);
  }
  for (const grade of selfGrades) {
    if (!SELF_GRADE_STATUSES.includes(grade?.status)) {
      throw new Error(`selfGrades entries must have a status of ${SELF_GRADE_STATUSES.join(", ")}`);
    }
  }

  const rating = mapSelfGradeToRating(selfGrades);
  await recordTopicReview(appDataDir, question.topicId, rating);

  const { pendingAnswer, ...questionWithoutPending } = question;
  const entry = {
    ...questionWithoutPending,
    ...pendingAnswer,
    selfGrades,
    rating,
    answeredAt: new Date().toISOString(),
  };
  const updated = await recordAnswer(appDataDir, sessionId, entry);
  return { ok: true, finalized: true, session: updated };
}
