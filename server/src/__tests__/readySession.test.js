import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubject } from "../subjects.js";
import { addPlannedTopics, listTopics, getTopicById } from "../topics.js";
import { addBankQuestions, listBankQuestions } from "../questionBank.js";
import { createSession, getSession } from "../sessions.js";
import {
  pickBankQuestion,
  publicQuestionView,
  gradeAutoGradedAnswer,
  mapAutoGradeToRating,
  mapSelfGradeToRating,
  generateNextReadyQuestion,
  submitReadyAnswer,
  submitReadySelfGrade,
} from "../readySession.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-ready-session-"));
}

function shortAnswerQuestion(overrides = {}) {
  return {
    type: "short_answer",
    prompt: "Explain recursion.",
    difficulty: "medium",
    modelAnswer: "A function that calls itself.",
    rubric: ["mentions a base case", "mentions the function calling itself"],
    misconceptions: ["confusing it with iteration"],
    ...overrides,
  };
}

async function seedSubjectWithTopic(dir) {
  const subject = await createSubject(dir, { name: "Algorithms" });
  const [topic] = await addPlannedTopics(dir, subject.id, ["Recursion"]);
  return { subject, topic };
}

// --- pickBankQuestion ---------------------------------------------------

test("pickBankQuestion returns null for an empty bank", () => {
  assert.equal(pickBankQuestion([]), null);
});

test("pickBankQuestion prefers a never-shown question over a shown one", () => {
  const shown = { id: "a", seenCount: 1, lastShownAt: new Date().toISOString() };
  const neverShown = { id: "b", seenCount: 0, lastShownAt: null };
  assert.equal(pickBankQuestion([shown, neverShown]).id, "b");
});

test("pickBankQuestion breaks a seenCount tie by the oldest lastShownAt", () => {
  const older = { id: "a", seenCount: 1, lastShownAt: "2026-01-01T00:00:00.000Z" };
  const newer = { id: "b", seenCount: 1, lastShownAt: "2026-06-01T00:00:00.000Z" };
  assert.equal(pickBankQuestion([newer, older]).id, "a");
});

// --- publicQuestionView --------------------------------------------------

test("publicQuestionView strips answer-key fields but keeps choices", () => {
  const question = {
    bankQuestionId: "q1",
    type: "multiple_choice",
    prompt: "p",
    choices: ["a", "b"],
    correctIndex: 1,
    modelAnswer: "b",
    rubric: [],
    misconceptions: [],
    clozeAnswer: undefined,
  };
  const view = publicQuestionView(question);
  assert.deepEqual(view, { bankQuestionId: "q1", type: "multiple_choice", prompt: "p", choices: ["a", "b"] });
});

// --- gradeAutoGradedAnswer / mapAutoGradeToRating ------------------------

test("gradeAutoGradedAnswer grades multiple_choice by index", () => {
  const q = { type: "multiple_choice", correctIndex: 2 };
  assert.equal(gradeAutoGradedAnswer(q, { selectedIndex: 2 }), true);
  assert.equal(gradeAutoGradedAnswer(q, { selectedIndex: 0 }), false);
});

test("gradeAutoGradedAnswer grades cloze case-insensitively and trimmed", () => {
  const q = { type: "cloze", clozeAnswer: "mitochondria" };
  assert.equal(gradeAutoGradedAnswer(q, { answerText: "  Mitochondria  " }), true);
  assert.equal(gradeAutoGradedAnswer(q, { answerText: "nucleus" }), false);
});

test("gradeAutoGradedAnswer rejects a non-auto-gradable type", () => {
  assert.throws(() => gradeAutoGradedAnswer({ type: "short_answer" }, {}), /only applies to/);
});

test("mapAutoGradeToRating maps correct to good and incorrect to again", () => {
  assert.equal(mapAutoGradeToRating(true), "good");
  assert.equal(mapAutoGradeToRating(false), "again");
});

// --- mapSelfGradeToRating -------------------------------------------------

test("mapSelfGradeToRating: all got_it maps to good", () => {
  assert.equal(mapSelfGradeToRating([{ status: "got_it" }, { status: "got_it" }]), "good");
});

test("mapSelfGradeToRating: any partly (no missed) maps to hard", () => {
  assert.equal(mapSelfGradeToRating([{ status: "got_it" }, { status: "partly" }]), "hard");
});

test("mapSelfGradeToRating: any missed maps to again, even alongside got_it/partly", () => {
  assert.equal(mapSelfGradeToRating([{ status: "got_it" }, { status: "partly" }, { status: "missed" }]), "again");
});

// --- generateNextReadyQuestion --------------------------------------------

test("generateNextReadyQuestion reports an empty bank without mutating the session", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });

  const result = await generateNextReadyQuestion(dir, session.id);
  assert.equal(result.ok, false);
  assert.equal(result.noBank, true);
  assert.equal(result.topicId, topic.id);
  assert.deepEqual(await getSession(dir, session.id), session);
});

test("generateNextReadyQuestion serves a bank question and marks it shown", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  const [bankQuestion] = await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });

  const result = await generateNextReadyQuestion(dir, session.id);
  assert.equal(result.ok, true);
  assert.equal(result.session.status, "waiting");
  assert.equal(result.session.currentQuestion.bankQuestionId, bankQuestion.id);
  assert.equal(result.session.currentQuestion.prompt, "Explain recursion.");

  const [storedQuestion] = await listBankQuestions(dir, topic.id);
  assert.equal(storedQuestion.seenCount, 1);
  assert.equal(typeof storedQuestion.lastShownAt, "string");
});

test("generateNextReadyQuestion ends the session once every topic has a history entry", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });

  await generateNextReadyQuestion(dir, session.id);
  await submitReadyAnswer(dir, session.id, { answerText: "it calls itself with a base case", confidence: 3 });
  await submitReadySelfGrade(dir, session.id, { selfGrades: [{ status: "got_it" }, { status: "got_it" }] });

  const result = await generateNextReadyQuestion(dir, session.id);
  assert.equal(result.ok, true);
  assert.equal(result.done, true);
  assert.equal(result.session.status, "completed");
});

test("generateNextReadyQuestion rejects a live-mode session", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "live", topicIds: [topic.id] });
  await assert.rejects(() => generateNextReadyQuestion(dir, session.id), /only applies to ready-mode sessions/);
});

test("generateNextReadyQuestion rejects a session with no topics", async () => {
  const dir = await scratchDir();
  const { subject } = await seedSubjectWithTopic(dir);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready" });
  await assert.rejects(() => generateNextReadyQuestion(dir, session.id), /no topics to ask about/);
});

test("generateNextReadyQuestion rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => generateNextReadyQuestion(dir, "no-such-id"), /Session not found/);
});

// --- submitReadyAnswer: auto-graded (multiple_choice / cloze) ------------

test("submitReadyAnswer finalizes a correct multiple_choice answer as good", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [
    { type: "multiple_choice", prompt: "p", difficulty: "medium", modelAnswer: "b", rubric: [], misconceptions: [], choices: ["a", "b"], correctIndex: 1 },
  ]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);

  const result = await submitReadyAnswer(dir, session.id, { selectedIndex: 1, confidence: 4 });
  assert.equal(result.ok, true);
  assert.equal(result.finalized, true);
  assert.equal(result.isCorrect, true);
  assert.equal(result.session.status, "active");
  assert.equal(result.session.history[0].rating, "good");
  assert.equal(result.session.history[0].selectedIndex, 1);

  const topicAfter = await getTopicById(dir, topic.id);
  assert.equal(topicAfter.fsrs.reps, 1);
});

test("submitReadyAnswer finalizes an incorrect cloze answer as again", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [
    { type: "cloze", prompt: "The ___ calls itself.", difficulty: "intro", modelAnswer: "function", rubric: [], misconceptions: [], clozeAnswer: "function" },
  ]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);

  const result = await submitReadyAnswer(dir, session.id, { answerText: "loop", confidence: 2 });
  assert.equal(result.isCorrect, false);
  assert.equal(result.session.history[0].rating, "again");
  assert.equal(result.session.history[0].answerText, "loop");
});

test("submitReadyAnswer rejects a multiple_choice submission with no selectedIndex", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [
    { type: "multiple_choice", prompt: "p", difficulty: "medium", modelAnswer: "b", rubric: [], misconceptions: [], choices: ["a", "b"], correctIndex: 1 },
  ]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);
  await assert.rejects(() => submitReadyAnswer(dir, session.id, { confidence: 3 }), /selectedIndex must be an integer/);
});

// --- submitReadyAnswer: self-graded reveal step --------------------------

test("submitReadyAnswer stashes a self-graded answer and reveals the model answer/rubric without finalizing", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);

  const result = await submitReadyAnswer(dir, session.id, { answerText: "it calls itself", confidence: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
  assert.equal(result.modelAnswer, "A function that calls itself.");
  assert.deepEqual(result.rubric, ["mentions a base case", "mentions the function calling itself"]);
  assert.equal(result.session.status, "waiting");
  assert.equal(result.session.history.length, 0);

  const topicAfter = await getTopicById(dir, topic.id);
  assert.equal(topicAfter.fsrs.reps, 0);
});

test("submitReadyAnswer rejects a blank self-graded answer", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);
  await assert.rejects(() => submitReadyAnswer(dir, session.id, { answerText: "  ", confidence: 3 }), /answerText must be a non-empty string/);
});

test("submitReadyAnswer rejects a missing or out-of-range confidence", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);
  await assert.rejects(() => submitReadyAnswer(dir, session.id, { answerText: "x" }), /confidence must be an integer from 1 to 5/);
  await assert.rejects(() => submitReadyAnswer(dir, session.id, { answerText: "x", confidence: 6 }), /confidence must be an integer from 1 to 5/);
});

test("submitReadyAnswer rejects a second submission once a pending answer already exists", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);
  await submitReadyAnswer(dir, session.id, { answerText: "it calls itself", confidence: 3 });
  await assert.rejects(
    () => submitReadyAnswer(dir, session.id, { answerText: "again", confidence: 3 }),
    /already has a pending answer awaiting self-grade/,
  );
});

test("submitReadyAnswer rejects a session with no current question", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await assert.rejects(() => submitReadyAnswer(dir, session.id, { answerText: "x", confidence: 3 }), /no current question to answer/);
});

test("submitReadyAnswer rejects a live-mode session", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "live", topicIds: [topic.id] });
  await assert.rejects(() => submitReadyAnswer(dir, session.id, { answerText: "x", confidence: 3 }), /only applies to ready-mode sessions/);
});

// --- submitReadySelfGrade --------------------------------------------------

test("submitReadySelfGrade finalizes with a good rating when every point is got_it", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);
  await submitReadyAnswer(dir, session.id, { answerText: "it calls itself with a base case", confidence: 4 });

  const result = await submitReadySelfGrade(dir, session.id, {
    selfGrades: [{ status: "got_it" }, { status: "got_it" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.session.status, "active");
  assert.equal(result.session.history.length, 1);
  const entry = result.session.history[0];
  assert.equal(entry.rating, "good");
  assert.equal(entry.answerText, "it calls itself with a base case");
  assert.equal(entry.confidence, 4);
  assert.deepEqual(entry.selfGrades, [{ status: "got_it" }, { status: "got_it" }]);
  assert.equal(entry.pendingAnswer, undefined);
  assert.equal(result.session.currentQuestion, null);

  const topicAfter = await getTopicById(dir, topic.id);
  assert.equal(topicAfter.fsrs.reps, 1);
});

test("submitReadySelfGrade finalizes with an again rating when a point is missed", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);
  await submitReadyAnswer(dir, session.id, { answerText: "not sure", confidence: 1 });

  const result = await submitReadySelfGrade(dir, session.id, {
    selfGrades: [{ status: "missed" }, { status: "partly" }],
  });
  assert.equal(result.session.history[0].rating, "again");
});

test("submitReadySelfGrade rejects a wrong number of selfGrades entries", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);
  await submitReadyAnswer(dir, session.id, { answerText: "x", confidence: 3 });
  await assert.rejects(
    () => submitReadySelfGrade(dir, session.id, { selfGrades: [{ status: "got_it" }] }),
    /selfGrades must have exactly 2 entries/,
  );
});

test("submitReadySelfGrade rejects an invalid status value", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);
  await submitReadyAnswer(dir, session.id, { answerText: "x", confidence: 3 });
  await assert.rejects(
    () => submitReadySelfGrade(dir, session.id, { selfGrades: [{ status: "got_it" }, { status: "nope" }] }),
    /selfGrades entries must have a status of/,
  );
});

test("submitReadySelfGrade rejects a question with no pending answer yet", async () => {
  const dir = await scratchDir();
  const { subject, topic } = await seedSubjectWithTopic(dir);
  await addBankQuestions(dir, topic.id, subject.id, [shortAnswerQuestion()]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await generateNextReadyQuestion(dir, session.id);
  await assert.rejects(
    () => submitReadySelfGrade(dir, session.id, { selfGrades: [{ status: "got_it" }, { status: "got_it" }] }),
    /no pending answer to self-grade yet/,
  );
});

test("submitReadySelfGrade rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => submitReadySelfGrade(dir, "no-such-id", { selfGrades: [] }), /Session not found/);
});

// --- full round-trip: two topics, one self-graded + one auto-graded -----

test("full ready-mode round trip across two topics ends the session naturally", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "Algorithms" });
  const [t1, t2] = await addPlannedTopics(dir, subject.id, ["Recursion", "Sorting"]);
  await addBankQuestions(dir, t1.id, subject.id, [shortAnswerQuestion()]);
  await addBankQuestions(dir, t2.id, subject.id, [
    { type: "multiple_choice", prompt: "Which is a stable sort?", difficulty: "medium", modelAnswer: "Merge sort", rubric: [], misconceptions: [], choices: ["Quicksort", "Merge sort"], correctIndex: 1 },
  ]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [t1.id, t2.id] });

  const q1 = await generateNextReadyQuestion(dir, session.id);
  assert.equal(q1.session.currentQuestion.topicId, t1.id);
  await submitReadyAnswer(dir, session.id, { answerText: "it calls itself", confidence: 3 });
  await submitReadySelfGrade(dir, session.id, { selfGrades: [{ status: "got_it" }, { status: "got_it" }] });

  const q2 = await generateNextReadyQuestion(dir, session.id);
  assert.equal(q2.session.currentQuestion.topicId, t2.id);
  const a2 = await submitReadyAnswer(dir, session.id, { selectedIndex: 1, confidence: 5 });
  assert.equal(a2.isCorrect, true);

  const done = await generateNextReadyQuestion(dir, session.id);
  assert.equal(done.done, true);
  assert.equal(done.session.status, "completed");
  assert.equal(done.session.history.length, 2);
});
