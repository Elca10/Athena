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
// client before the question's been answered — `publicQuestionView` is the
// scrubbed shape routes/sessions.js applies to every session view a client
// can request (not just the initial "here's your question" response; also
// GET /api/sessions and GET /api/sessions/:id, which otherwise hand back
// the session's raw stored `currentQuestion` — that includes a Waiting
// session's answer key before the resuming client has had a chance to
// answer it). Once a self-graded question has a `pendingAnswer`
// (`submitReadyAnswer`'s response already revealed modelAnswer/rubric/
// misconceptions at that point, same as a fresh /ready/answer call),
// `publicQuestionView` keeps them — resuming a Waiting session back into
// the self-grade step needs them, and they're no longer a secret once the
// user has already answered.

import { getSession, setCurrentQuestion, recordPendingAnswer, recordAnswer, promptReflection, listSessions } from "./sessions.js";
import { getTopicById, recordTopicReview } from "./topics.js";
import { listBankQuestions, markQuestionShown, isBankDrained } from "./questionBank.js";
import { getSubject } from "./subjects.js";
import { topUpTopicBanks } from "./questionBankGeneration.js";
import { pickNextTopicId, recentlyAskedTypes } from "./liveSession.js";
import { targetDifficultyForCard } from "./scheduler.js";
import { justReachedMastered } from "./subjectSummary.js";

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
 *
 * `preferGeneration` (set by `generateNextReadyQuestion` when the topic
 * has never been reviewed — `isNewTopic`, same check liveSession.js uses)
 * serves an unseen `isGenerationQuestion`-flagged question ahead of the
 * usual seenCount/lastShownAt order, once — SPEC.md section 6's
 * Generation principle, the Ready-mode counterpart to Live mode's
 * attempt-first framing for a topic's first-ever question. Once the topic
 * has been reviewed at least once, `isNewTopic` goes false on its own and
 * this has no further effect; a bank with no generation-flagged question
 * (every top-up, and any initial bank generated for an already-reviewed
 * topic) falls straight through to the normal order.
 *
 * `targetDifficulty` and `recentTypes` are section 3's Desirable difficulty
 * and Variation rows: narrow the candidate pool to the topic's target
 * difficulty (from `scheduler.js`'s `targetDifficultyForCard`), then narrow
 * further to exclude recently-asked types (from `recentlyAskedTypes`,
 * liveSession.js), each applied ONLY when doing so leaves at least one
 * question — "fall back gracefully when a bank has no question of the
 * preferred type/difficulty" rather than ever refuse to serve one. Difficulty
 * narrows first, type second: a bank thin enough to need both relaxed still
 * gets the mastery-appropriate difficulty before the variety nice-to-have.
 * Both are plain filters over already-known bank-question fields — no new
 * data, no migration risk for questions predating either field.
 */
export function pickBankQuestion(questions, { preferGeneration = false, targetDifficulty = null, recentTypes = [] } = {}) {
  if (!questions.length) return null;
  if (preferGeneration) {
    const generation = questions.find((q) => q.isGenerationQuestion && q.seenCount === 0);
    if (generation) return generation;
  }
  let candidates = questions;
  if (targetDifficulty) {
    const atDifficulty = candidates.filter((q) => q.difficulty === targetDifficulty);
    if (atDifficulty.length) candidates = atDifficulty;
  }
  if (recentTypes.length) {
    const notRecent = candidates.filter((q) => !recentTypes.includes(q.type));
    if (notRecent.length) candidates = notRecent;
  }
  return candidates.slice().sort((a, b) => {
    if (a.seenCount !== b.seenCount) return a.seenCount - b.seenCount;
    const aShown = a.lastShownAt ? Date.parse(a.lastShownAt) : -Infinity;
    const bShown = b.lastShownAt ? Date.parse(b.lastShownAt) : -Infinity;
    return aShown - bShown;
  })[0];
}

/**
 * Strips a question's answer-key fields before it reaches the client —
 * `choices` (the option text for multiple_choice) stays, since the user
 * needs it to answer; `correctIndex` and `clozeAnswer` never belong to the
 * client (auto-graded types finalize server-side and never set
 * `pendingAnswer`). `modelAnswer`/`rubric`/`misconceptions` are kept only
 * once `pendingAnswer` is set — the user has already answered and
 * `submitReadyAnswer` already revealed them for the self-grade step, so a
 * later view of the same question (resuming a Waiting session) needs them
 * too; before that, they're still a secret. Pure, exported for its own
 * test.
 */
export function publicQuestionView(question) {
  const { correctIndex, clozeAnswer, modelAnswer, rubric, misconceptions, ...rest } = question;
  return question.pendingAnswer ? { ...rest, modelAnswer, rubric, misconceptions } : rest;
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
 * Ready mode's deterministic counterpart to Live mode's model-written
 * confidence-vs-correctness callout (liveSession.js's `buildGradingPrompt`):
 * no model call ever grades a Ready answer, so the persona's calibration
 * rule has to be applied in plain code here instead, using the exact
 * wording its "Confidence vs. correctness" section gives as the model
 * (concise, one sentence, conversational). Only fires on a clear mismatch
 * (confidence >= 4 and wrong, or confidence <= 2 and right) — `isCorrect`
 * of `null` (an ambiguous self-grade: some rubric points right, some not)
 * deliberately gets no callout rather than guessing which way it leans.
 * Pure, exported for its own test.
 */
export function confidenceMismatchNote(confidence, isCorrect) {
  if (!Number.isInteger(confidence) || typeof isCorrect !== "boolean") return null;
  if (confidence >= 4 && isCorrect === false) {
    return "You were sure about this one, and it's wrong — the most useful kind of mistake to look at.";
  }
  if (confidence <= 2 && isCorrect === true) {
    return "You weren't sure here, and it's right.";
  }
  return null;
}

/**
 * After a Ready session ends naturally, checks each topic it covered for a
 * drained bank — SPEC.md section 5: "topped up after a Ready session that
 * drained a topic's unused questions, triggered by that session ending" —
 * and tops up any that are. `isBankDrained` only looks at a topic's own
 * bank, independent of which topic just ended the session, so this checks
 * every topic the session touched, not just the last one asked. Runs
 * sequentially and is never fatal to the session having ended — a failed
 * top-up (model-call failure, unparseable reply) is reported in the
 * returned array alongside a successful one rather than thrown, same
 * "real, recoverable outcome" posture a single failed turn already gets
 * elsewhere in this module. Exported for its own test; `topUp` is a test
 * seam for `topUpTopicBanks`.
 */
export async function topUpDrainedTopics(appDataDir, topicIds, { topUp = topUpTopicBanks } = {}) {
  // Drained topics grouped by subject: one top-up (as few turns as the
  // batching allows) per subject, not one turn per topic (issue #10).
  const drainedBySubject = new Map();
  for (const topicId of topicIds) {
    const questions = await listBankQuestions(appDataDir, topicId);
    if (!isBankDrained(questions)) continue;

    const topic = await getTopicById(appDataDir, topicId);
    if (!topic) continue; // a session's own topicIds were already resolved when it was built
    if (!drainedBySubject.has(topic.subjectId)) drainedBySubject.set(topic.subjectId, []);
    drainedBySubject.get(topic.subjectId).push(topicId);
  }

  const results = [];
  for (const [subjectId, ids] of drainedBySubject) {
    const subject = await getSubject(appDataDir, subjectId);
    const result = await topUp(appDataDir, ids, { subjectName: subject?.name ?? "" });
    results.push({ topicIds: ids, ...result });
  }
  return results;
}

/**
 * Serves a Ready session's next question: `pickNextTopicId` decides which
 * due topic (if any) is next, same interleaving-order logic Live mode
 * uses; `pickBankQuestion` picks the least-recently-shown bank question for
 * it. Once every topic's been asked, the session moves to "waiting" for
 * its end-of-session reflection (`sessions.js`'s `promptReflection`, same
 * as Live mode — `reflection.js` is what actually finalizes it) and tops
 * up any topic it drained (`topUpDrainedTopics`), mirroring
 * `generateNextLiveQuestion`'s `{ok: true, done: true, awaitingReflection:
 * true, session}` shape with an added `bankTopUps` array (empty when
 * nothing needed topping up).
 * An empty/not-yet-generated bank for the next topic (SPEC.md section 5's
 * "empty or thin bank") is a real, recoverable outcome, not a caller
 * mistake — it comes back as `{ok: false, noBank: true, topicId, reason}`
 * with the session untouched, same posture `generateNextLiveQuestion`
 * gives a model-call failure, so a retry after generating a bank (or the
 * caller choosing Live instead, per the spec) doesn't need any cleanup.
 * Validation errors (bad session id, wrong mode, a question already
 * served, no topics at all) throw, same as Live.
 */
export async function generateNextReadyQuestion(appDataDir, sessionId, { topUp = topUpTopicBanks } = {}) {
  const session = await getSession(appDataDir, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.mode !== "ready") throw new Error(`generateNextReadyQuestion only applies to ready-mode sessions: ${sessionId}`);
  if (session.currentQuestion) throw new Error(`Session already has a current question: ${sessionId}`);
  if (!session.topicIds.length) throw new Error(`Session has no topics to ask about: ${sessionId}`);
  if (session.reflectionPending) return { ok: true, done: true, awaitingReflection: true, session, bankTopUps: [] };

  const topicId = pickNextTopicId(session.topicIds, session.history);
  if (topicId === null) {
    const waiting = await promptReflection(appDataDir, sessionId);
    const bankTopUps = await topUpDrainedTopics(appDataDir, session.topicIds, { topUp });
    return { ok: true, done: true, awaitingReflection: true, session: waiting, bankTopUps };
  }
  const topic = await getTopicById(appDataDir, topicId);
  if (!topic) throw new Error(`Topic not found: ${topicId}`);

  const bankQuestions = await listBankQuestions(appDataDir, topicId);
  const isNewTopic = (topic.fsrs?.reps ?? 0) === 0;
  const sessions = await listSessions(appDataDir, { includeArchived: true });
  const recentTypes = recentlyAskedTypes(sessions, topicId);
  const targetDifficulty = targetDifficultyForCard(topic.fsrs);
  const picked = pickBankQuestion(bankQuestions, { preferGeneration: isNewTopic, recentTypes, targetDifficulty });
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
    isGenerationQuestion: picked.isGenerationQuestion,
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
    const topicBefore = await getTopicById(appDataDir, question.topicId);
    const topicAfter = await recordTopicReview(appDataDir, question.topicId, rating);
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
    // Graded now, so the answer key is no longer a secret: send the right
    // answer (and the explanation) so a miss can actually teach something.
    const correctAnswer = question.type === "multiple_choice" ? question.choices?.[question.correctIndex] ?? null : question.clozeAnswer ?? null;
    // Deterministic, persona-consistent callouts (SPEC-v2.md section 5) —
    // no model call either way here, so both are plain code: the
    // confidence/correctness mismatch one-liner (`confidenceMismatchNote`)
    // and the milestone-applause one (`justReachedMastered`, subjectSummary.js).
    const mismatchNote = confidenceMismatchNote(confidence, isCorrect);
    const milestone = topicBefore ? (justReachedMastered(topicBefore, topicAfter) ? `"${topicBefore.name}" just reached mastered.` : null) : null;
    return { ok: true, finalized: true, isCorrect, correctAnswer, modelAnswer: question.modelAnswer ?? null, mismatchNote, milestone, session: updated };
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
  const topicBefore = await getTopicById(appDataDir, question.topicId);
  const topicAfter = await recordTopicReview(appDataDir, question.topicId, rating);

  const { pendingAnswer, ...questionWithoutPending } = question;
  const entry = {
    ...questionWithoutPending,
    ...pendingAnswer,
    selfGrades,
    rating,
    answeredAt: new Date().toISOString(),
  };
  const updated = await recordAnswer(appDataDir, sessionId, entry);
  // Same deterministic callouts as the auto-graded branch above. A
  // self-grade's "correctness" for the mismatch note is only meaningful at
  // the two clean ends of `mapSelfGradeToRating`: "good" (every rubric
  // point got_it — unambiguously right) and "again" (something missed —
  // unambiguously wrong). "hard" (a mix of got_it/partly, no misses) is
  // genuinely in between, so it gets no callout rather than a guess either
  // way.
  const isCorrect = rating === "good" ? true : rating === "again" ? false : null;
  const mismatchNote = confidenceMismatchNote(pendingAnswer?.confidence, isCorrect);
  const milestone = topicBefore ? (justReachedMastered(topicBefore, topicAfter) ? `"${topicBefore.name}" just reached mastered.` : null) : null;
  return { ok: true, finalized: true, mismatchNote, milestone, session: updated };
}
