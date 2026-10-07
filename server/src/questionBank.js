// Question banks (SPEC.md section 5's Ready mode: "pre-generated questions,
// model answers and rubrics"). This module is only the data model — list
// and add, keyed by topic — the same split topics.js/topicExtraction.js
// already has between "the stored shape" and "the model turn that fills
// it" (questionBankGeneration.js). Serving a question to a Ready session
// (picking one that hasn't been seen too recently) and local auto-grading
// are both later build steps; this file only needs to track `seenCount`/
// `lastShownAt` now so that data exists for those steps to read.

import { randomUUID } from "node:crypto";
import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";

const FILE_NAME = "questionBank.json";

// SPEC.md section 5's full type list. A Live-mode question
// (liveSession.js) uses a subset of these — free-form types only, since
// Live has no bank/rubric to hang auto-grading on — but a bank question
// covers all eight, including the two (multiple_choice, cloze) that need
// real answer-key data to auto-grade locally.
export const QUESTION_TYPES = [
  "free_recall",
  "explain_why",
  "apply",
  "compare_contrast",
  "short_answer",
  "cloze",
  "multiple_choice",
  "worked_problem",
];

export const DIFFICULTIES = ["intro", "medium", "hard"];

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, []);
}

export async function listBankQuestions(appDataDir, topicId) {
  const all = await storeFor(appDataDir).read();
  return all.filter((q) => q.topicId === topicId);
}

/**
 * Adds already-validated bank questions for one topic (callers — currently
 * only questionBankGeneration.js — validate shape/types before calling
 * this; this module only owns storage, not reply parsing). Each `question`
 * is `{type, prompt, difficulty, modelAnswer, rubric, misconceptions,
 * choices?, correctIndex?, clozeAnswer?}`. Returns the stored rows (with
 * ids and bookkeeping fields attached) so a caller can report how many
 * were added.
 */
export async function addBankQuestions(appDataDir, topicId, subjectId, questions) {
  if (!questions.length) return [];
  const now = new Date().toISOString();
  const rows = questions.map((q) => ({
    id: randomUUID(),
    topicId,
    subjectId,
    type: q.type,
    prompt: q.prompt,
    difficulty: q.difficulty,
    modelAnswer: q.modelAnswer,
    rubric: q.rubric ?? [],
    misconceptions: q.misconceptions ?? [],
    ...(q.type === "multiple_choice" ? { choices: q.choices, correctIndex: q.correctIndex } : {}),
    ...(q.type === "cloze" ? { clozeAnswer: q.clozeAnswer } : {}),
    createdAt: now,
    // "Questions are not reused verbatim too soon; the bank tracks which
    // questions a user has seen" (SPEC.md section 5) — the Ready-session
    // serving step (not yet built) is what reads/updates these.
    seenCount: 0,
    lastShownAt: null,
  }));
  await storeFor(appDataDir).update((current) => [...current, ...rows]);
  return rows;
}

/**
 * Looks up a single bank question by id, regardless of topic — needed once
 * a session's `currentQuestion` only carries a `bankQuestionId` reference.
 * Returns `null` rather than throwing, same as `getSession`/`getSubject`/
 * `getTopicById`.
 */
export async function getBankQuestionById(appDataDir, id) {
  const all = await storeFor(appDataDir).read();
  return all.find((q) => q.id === id) ?? null;
}

/**
 * Whether every question in a topic's bank has been shown at least once —
 * SPEC.md section 5's "topped up after a Ready session that drained a
 * topic's unused questions". A bank that's still empty (never generated)
 * is not "drained" in this sense — that's the separate "empty or thin
 * bank" case `readySession.js`'s `pickBankQuestion`/`noBank` already
 * handle — so an empty list is `false`, not `true`. Pure, exported for its
 * own test.
 */
export function isBankDrained(questions) {
  return questions.length > 0 && questions.every((q) => q.seenCount > 0);
}

/**
 * Marks a bank question as shown (SPEC.md section 5: "the bank tracks
 * which questions a user has seen") — `readySession.js`'s `pickBankQuestion`
 * reads `seenCount`/`lastShownAt` back to avoid reusing the same question
 * too soon. Throws on an unknown id, same posture as `recordTopicReview`.
 */
export async function markQuestionShown(appDataDir, id, now = new Date()) {
  const all = await storeFor(appDataDir).update((current) => {
    const index = current.findIndex((q) => q.id === id);
    if (index === -1) throw new Error(`Bank question not found: ${id}`);
    const next = current.slice();
    next[index] = { ...next[index], seenCount: next[index].seenCount + 1, lastShownAt: now.toISOString() };
    return next;
  });
  return all.find((q) => q.id === id);
}
