import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubject } from "../subjects.js";
import { addPlannedTopics, listTopics, recordTopicReview } from "../topics.js";
import { createSession, getSession, setCurrentQuestion, recordAnswer } from "../sessions.js";
import { addPreference } from "../preferences.js";
import {
  pickNextTopicId,
  buildFirstQuestionPrompt,
  parseFirstQuestionReply,
  generateNextLiveQuestion,
  runFirstQuestionTurn,
  buildGradingPrompt,
  parseGradingReply,
  runGradingTurn,
  submitLiveAnswer,
} from "../liveSession.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-live-session-"));
}

// Same technique topicExtraction.test.js uses: an env whose PATH points
// nowhere real, so "claude not found" is deterministic on any machine.
function emptyPathEnv() {
  return { PATH: os.tmpdir() };
}

async function seedSession(dir, { reviewed = false } = {}) {
  const subject = await createSubject(dir, { name: "Organic Chemistry" });
  const [topic] = await addPlannedTopics(dir, subject.id, [{ name: "SN1 vs SN2", notes: "reaction mechanisms" }]);
  if (reviewed) await recordTopicReview(dir, topic.id, "good");
  const topics = await listTopics(dir, subject.id);
  const session = await createSession(dir, {
    subjectIds: [subject.id],
    mode: "live",
    topicIds: [topics[0].id],
  });
  return { subject, topic: topics[0], session };
}

// Seeds a session with two topics so advancing past the first one has
// somewhere real to advance to.
async function seedTwoTopicSession(dir) {
  const subject = await createSubject(dir, { name: "Organic Chemistry" });
  const [t1, t2] = await addPlannedTopics(dir, subject.id, [{ name: "SN1 vs SN2" }, { name: "E1 vs E2" }]);
  const session = await createSession(dir, {
    subjectIds: [subject.id],
    mode: "live",
    topicIds: [t1.id, t2.id],
  });
  return { subject, topic1: t1, topic2: t2, session };
}

// --- pickNextTopicId ---------------------------------------------------

test("pickNextTopicId returns the first topic when history is empty", () => {
  assert.equal(pickNextTopicId(["a", "b", "c"], []), "a");
});

test("pickNextTopicId skips topics already present in history", () => {
  assert.equal(pickNextTopicId(["a", "b", "c"], [{ topicId: "a" }]), "b");
});

test("pickNextTopicId preserves topicIds order, not history order", () => {
  assert.equal(pickNextTopicId(["a", "b", "c"], [{ topicId: "b" }]), "a");
});

test("pickNextTopicId returns null once every topic has a history entry", () => {
  assert.equal(pickNextTopicId(["a", "b"], [{ topicId: "a" }, { topicId: "b" }]), null);
});

test("pickNextTopicId treats a missing history as having nothing asked yet", () => {
  assert.equal(pickNextTopicId(["a"], undefined), "a");
});

// --- buildFirstQuestionPrompt -----------------------------------------------

test("buildFirstQuestionPrompt frames a brand-new topic as attempt-first", () => {
  const prompt = buildFirstQuestionPrompt({
    subjectNames: ["Organic Chemistry"],
    topic: { name: "SN1 vs SN2", notes: "reaction mechanisms" },
    isNewTopic: true,
  });
  assert.match(prompt, /Organic Chemistry/);
  assert.match(prompt, /SN1 vs SN2/);
  assert.match(prompt, /reaction mechanisms/);
  assert.match(prompt, /do NOT explain it first/);
  assert.match(prompt, /athena-live-question/);
});

test("buildFirstQuestionPrompt frames a reviewed topic as a real recall/application test", () => {
  const prompt = buildFirstQuestionPrompt({
    subjectNames: ["Organic Chemistry"],
    topic: { name: "SN1 vs SN2", notes: "" },
    isNewTopic: false,
  });
  assert.match(prompt, /reviewed this topic before/);
  assert.doesNotMatch(prompt, /do NOT explain it first/);
});

test("buildFirstQuestionPrompt handles no subject name and no notes", () => {
  const prompt = buildFirstQuestionPrompt({ subjectNames: [], topic: { name: "Topic X", notes: "" }, isNewTopic: true });
  assert.match(prompt, /an unspecified subject/);
});

test("buildFirstQuestionPrompt appends stored preferences when given any", () => {
  const prompt = buildFirstQuestionPrompt({
    subjectNames: ["Organic Chemistry"],
    topic: { name: "SN1 vs SN2", notes: "" },
    isNewTopic: true,
    preferences: [{ text: "harder questions on proofs" }],
  });
  assert.match(prompt, /standing study preferences/);
  assert.match(prompt, /harder questions on proofs/);
});

test("buildFirstQuestionPrompt adds nothing extra when there are no preferences", () => {
  const withEmpty = buildFirstQuestionPrompt({
    subjectNames: ["Organic Chemistry"],
    topic: { name: "SN1 vs SN2", notes: "" },
    isNewTopic: true,
    preferences: [],
  });
  const withNone = buildFirstQuestionPrompt({
    subjectNames: ["Organic Chemistry"],
    topic: { name: "SN1 vs SN2", notes: "" },
    isNewTopic: true,
  });
  assert.equal(withEmpty, withNone);
  assert.doesNotMatch(withEmpty, /standing study preferences/);
});

// --- parseFirstQuestionReply -------------------------------------------------

function fence(obj) {
  return `\`\`\`json athena-live-question\n${JSON.stringify(obj)}\n\`\`\``;
}

test("parseFirstQuestionReply accepts a well-formed tagged fence", () => {
  const reply = `Here you go.\n\n${fence({ prompt: "What is SN1?", type: "explain_why", difficulty: "medium" })}`;
  const result = parseFirstQuestionReply(reply);
  assert.deepEqual(result, { ok: true, question: { prompt: "What is SN1?", type: "explain_why", difficulty: "medium" } });
});

test("parseFirstQuestionReply accepts a plain (untagged) fence", () => {
  const reply = "```json\n" + JSON.stringify({ prompt: "What is SN2?", type: "free_recall", difficulty: "intro" }) + "\n```";
  const result = parseFirstQuestionReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.question.prompt, "What is SN2?");
});

test("parseFirstQuestionReply parses bare JSON with no fence at all", () => {
  const reply = JSON.stringify({ prompt: "Bare JSON question", type: "apply", difficulty: "hard" });
  const result = parseFirstQuestionReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.question.type, "apply");
});

test("parseFirstQuestionReply prefers the LAST fence, not an embedded example", () => {
  const example = fence({ prompt: "example placeholder", type: "free_recall", difficulty: "intro" });
  const real = fence({ prompt: "the real question", type: "short_answer", difficulty: "medium" });
  const reply = `Format looks like:\n${example}\n\nMy answer:\n${real}`;
  const result = parseFirstQuestionReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.question.prompt, "the real question");
});

test("parseFirstQuestionReply rejects an empty reply", () => {
  assert.deepEqual(parseFirstQuestionReply(""), { ok: false, reason: "the reply was empty" });
  assert.deepEqual(parseFirstQuestionReply("   "), { ok: false, reason: "the reply was empty" });
});

test("parseFirstQuestionReply rejects a reply with no readable JSON", () => {
  const result = parseFirstQuestionReply("I couldn't think of anything, sorry.");
  assert.equal(result.ok, false);
  assert.match(result.reason, /no readable question/);
});

test("parseFirstQuestionReply rejects a blank prompt", () => {
  const result = parseFirstQuestionReply(fence({ prompt: "   ", type: "free_recall", difficulty: "medium" }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /blank/);
});

test("parseFirstQuestionReply rejects an invalid question type", () => {
  const result = parseFirstQuestionReply(fence({ prompt: "What is SN1?", type: "multiple_choice", difficulty: "medium" }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /not one of/);
});

test("parseFirstQuestionReply defaults an invalid or missing difficulty to medium rather than rejecting", () => {
  const result = parseFirstQuestionReply(fence({ prompt: "What is SN1?", type: "free_recall", difficulty: "impossible" }));
  assert.equal(result.ok, true);
  assert.equal(result.question.difficulty, "medium");
});

test("parseFirstQuestionReply truncates an absurdly long prompt", () => {
  const long = "x".repeat(5000);
  const result = parseFirstQuestionReply(fence({ prompt: long, type: "free_recall", difficulty: "medium" }));
  assert.equal(result.ok, true);
  assert.equal(result.question.prompt.length, 2000);
});

// --- runFirstQuestionTurn (the CLI call itself) -----------------------------

test("runFirstQuestionTurn rejects with a clear error when the claude CLI can't be found", async () => {
  await assert.rejects(
    () => runFirstQuestionTurn("irrelevant prompt", { env: emptyPathEnv() }),
    (err) => {
      assert.ok(err.notFound || /ENOENT/.test(err.message));
      return true;
    },
  );
});

// --- generateNextLiveQuestion (the orchestration) --------------------------

test("generateNextLiveQuestion stores the question and moves the session to waiting", async () => {
  const dir = await scratchDir();
  const { session, topic, subject } = await seedSession(dir);
  const runTurn = async (prompt) => {
    assert.match(prompt, /SN1 vs SN2/);
    return fence({ prompt: "What do you think SN1 means?", type: "free_recall", difficulty: "intro" });
  };

  const result = await generateNextLiveQuestion(dir, session.id, { runTurn });
  assert.equal(result.ok, true);
  assert.equal(result.session.status, "waiting");
  assert.deepEqual(result.session.currentQuestion, {
    topicId: topic.id,
    subjectId: subject.id,
    prompt: "What do you think SN1 means?",
    type: "free_recall",
    difficulty: "intro",
    askedAt: result.session.currentQuestion.askedAt,
  });
  assert.equal(typeof result.session.currentQuestion.askedAt, "string");

  const stored = await getSession(dir, session.id);
  assert.deepEqual(stored, result.session);
});

test("generateNextLiveQuestion includes stored preferences in the prompt sent to the model", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir);
  await addPreference(dir, { text: "harder questions on proofs" });
  let seenPrompt = "";
  const runTurn = async (prompt) => {
    seenPrompt = prompt;
    return fence({ prompt: "What do you think SN1 means?", type: "free_recall", difficulty: "intro" });
  };
  await generateNextLiveQuestion(dir, session.id, { runTurn });
  assert.match(seenPrompt, /harder questions on proofs/);
});

test("generateNextLiveQuestion frames a reviewed topic differently from a brand-new one", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir, { reviewed: true });
  let seenPrompt = "";
  const runTurn = async (prompt) => {
    seenPrompt = prompt;
    return fence({ prompt: "Explain why SN1 is favored here.", type: "explain_why", difficulty: "medium" });
  };
  await generateNextLiveQuestion(dir, session.id, { runTurn });
  assert.match(seenPrompt, /reviewed this topic before/);
});

test("generateNextLiveQuestion leaves the session untouched when the model call fails", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir);
  const runTurn = async () => {
    throw new Error("claude exited with code 1: boom");
  };
  const result = await generateNextLiveQuestion(dir, session.id, { runTurn });
  assert.equal(result.ok, false);
  assert.match(result.reason, /boom/);

  const stored = await getSession(dir, session.id);
  assert.equal(stored.status, "active");
  assert.equal(stored.currentQuestion, null);
});

test("generateNextLiveQuestion leaves the session untouched when the reply doesn't parse", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir);
  const runTurn = async () => "no JSON here at all";
  const result = await generateNextLiveQuestion(dir, session.id, { runTurn });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no readable question/);

  const stored = await getSession(dir, session.id);
  assert.equal(stored.status, "active");
  assert.equal(stored.currentQuestion, null);
});

test("generateNextLiveQuestion rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => generateNextLiveQuestion(dir, "no-such-id"), /Session not found/);
});

test("generateNextLiveQuestion rejects a ready-mode session", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "History" });
  const [topic] = await addPlannedTopics(dir, subject.id, ["The French Revolution"]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await assert.rejects(() => generateNextLiveQuestion(dir, session.id), /only applies to live-mode sessions/);
});

test("generateNextLiveQuestion rejects a session with no topics", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "History" });
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "live" });
  await assert.rejects(() => generateNextLiveQuestion(dir, session.id), /no topics to ask about/);
});

test("generateNextLiveQuestion refuses to overwrite an existing current question", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir);
  const runTurn = async () => fence({ prompt: "First one", type: "free_recall", difficulty: "intro" });
  await generateNextLiveQuestion(dir, session.id, { runTurn });
  await assert.rejects(() => generateNextLiveQuestion(dir, session.id, { runTurn }), /already has a current question/);
});

test("generateNextLiveQuestion asks about the next unasked topic once the first has history", async () => {
  const dir = await scratchDir();
  const { session, topic1, topic2 } = await seedTwoTopicSession(dir);

  // Simulate the first topic already asked-and-answered: a history entry
  // naming topic1, no current question, status back to "active" — the
  // same state submitLiveAnswer leaves a session in.
  await setCurrentQuestion(dir, session.id, { topicId: topic1.id, prompt: "Q1" });
  await recordAnswer(dir, session.id, { topicId: topic1.id, prompt: "Q1", answerText: "a1" });

  let seenPrompt = "";
  const runTurn = async (prompt) => {
    seenPrompt = prompt;
    return fence({ prompt: "What about E1 vs E2?", type: "free_recall", difficulty: "intro" });
  };
  const result = await generateNextLiveQuestion(dir, session.id, { runTurn });
  assert.equal(result.ok, true);
  assert.equal(result.session.currentQuestion.topicId, topic2.id);
  assert.match(seenPrompt, /E1 vs E2/);
});

test("generateNextLiveQuestion ends the session once every topic has been asked, rather than generating another question", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir);
  await setCurrentQuestion(dir, session.id, { topicId: session.topicIds[0], prompt: "Q1" });
  await recordAnswer(dir, session.id, { topicId: session.topicIds[0], prompt: "Q1", answerText: "a1" });

  const runTurn = async () => assert.fail("should not call the model once every topic is already asked");
  const result = await generateNextLiveQuestion(dir, session.id, { runTurn });
  assert.deepEqual(result, { ok: true, done: true, session: result.session });
  assert.equal(result.session.status, "completed");
  assert.notEqual(result.session.endedAt, null);

  const stored = await getSession(dir, session.id);
  assert.equal(stored.status, "completed");
});

// --- buildGradingPrompt -------------------------------------------------

test("buildGradingPrompt includes the subject, topic, question, and answer", () => {
  const prompt = buildGradingPrompt({
    subjectNames: ["Organic Chemistry"],
    topic: { name: "SN1 vs SN2", notes: "reaction mechanisms" },
    question: { prompt: "What is SN1?", type: "explain_why", difficulty: "medium" },
    answerText: "SN1 is a unimolecular nucleophilic substitution.",
  });
  assert.match(prompt, /Organic Chemistry/);
  assert.match(prompt, /SN1 vs SN2/);
  assert.match(prompt, /reaction mechanisms/);
  assert.match(prompt, /What is SN1\?/);
  assert.match(prompt, /unimolecular nucleophilic substitution/);
  assert.match(prompt, /athena-live-feedback/);
});

test("buildGradingPrompt handles no subject name and no notes", () => {
  const prompt = buildGradingPrompt({
    subjectNames: [],
    topic: { name: "Topic X", notes: "" },
    question: { prompt: "Q?", type: "free_recall", difficulty: "intro" },
    answerText: "an answer",
  });
  assert.match(prompt, /an unspecified subject/);
});

test("buildGradingPrompt appends stored preferences when given any", () => {
  const prompt = buildGradingPrompt({
    subjectNames: ["Organic Chemistry"],
    topic: { name: "SN1 vs SN2", notes: "" },
    question: { prompt: "Q?", type: "free_recall", difficulty: "intro" },
    answerText: "an answer",
    preferences: [{ text: "always give a worked example after a miss" }],
  });
  assert.match(prompt, /standing study preferences/);
  assert.match(prompt, /worked example after a miss/);
});

// --- parseGradingReply ---------------------------------------------------

function feedbackFence(obj) {
  return `\`\`\`json athena-live-feedback\n${JSON.stringify(obj)}\n\`\`\``;
}

test("parseGradingReply accepts a well-formed tagged fence", () => {
  const reply = `Here's my grading.\n\n${feedbackFence({ feedback: "Mostly right, missed the mechanism.", rating: "hard" })}`;
  const result = parseGradingReply(reply);
  assert.deepEqual(result, { ok: true, feedback: "Mostly right, missed the mechanism.", rating: "hard" });
});

test("parseGradingReply accepts a plain (untagged) fence", () => {
  const reply = "```json\n" + JSON.stringify({ feedback: "Correct.", rating: "good" }) + "\n```";
  const result = parseGradingReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.rating, "good");
});

test("parseGradingReply parses bare JSON with no fence at all", () => {
  const reply = JSON.stringify({ feedback: "Wrong, try again.", rating: "again" });
  const result = parseGradingReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.rating, "again");
});

test("parseGradingReply prefers the LAST fence, not an embedded example", () => {
  const example = feedbackFence({ feedback: "example placeholder", rating: "easy" });
  const real = feedbackFence({ feedback: "the real feedback", rating: "hard" });
  const reply = `Format looks like:\n${example}\n\nMy grading:\n${real}`;
  const result = parseGradingReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.feedback, "the real feedback");
});

test("parseGradingReply rejects an empty reply", () => {
  assert.deepEqual(parseGradingReply(""), { ok: false, reason: "the reply was empty" });
});

test("parseGradingReply rejects a reply with no readable JSON", () => {
  const result = parseGradingReply("I couldn't grade this, sorry.");
  assert.equal(result.ok, false);
  assert.match(result.reason, /no readable grading result/);
});

test("parseGradingReply rejects a blank feedback", () => {
  const result = parseGradingReply(feedbackFence({ feedback: "   ", rating: "good" }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /blank/);
});

test("parseGradingReply rejects an invalid rating rather than defaulting it", () => {
  const result = parseGradingReply(feedbackFence({ feedback: "Looks fine.", rating: "perfect" }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /not one of/);
});

test("parseGradingReply truncates an absurdly long feedback", () => {
  const long = "x".repeat(5000);
  const result = parseGradingReply(feedbackFence({ feedback: long, rating: "good" }));
  assert.equal(result.ok, true);
  assert.equal(result.feedback.length, 2000);
});

// --- runGradingTurn (the CLI call itself) --------------------------------

test("runGradingTurn rejects with a clear error when the claude CLI can't be found", async () => {
  await assert.rejects(
    () => runGradingTurn("irrelevant prompt", { env: emptyPathEnv() }),
    (err) => {
      assert.ok(err.notFound || /ENOENT/.test(err.message));
      return true;
    },
  );
});

// --- submitLiveAnswer (the orchestration) --------------------------------

async function seedWaitingSession(dir, { reviewed = false } = {}) {
  const seeded = await seedSession(dir, { reviewed });
  const question = { topicId: seeded.topic.id, subjectId: seeded.subject.id, prompt: "What is SN1?", type: "explain_why", difficulty: "medium" };
  const session = await setCurrentQuestion(dir, seeded.session.id, question);
  return { ...seeded, session, question };
}

test("submitLiveAnswer grades the answer, updates FSRS, and records history", async () => {
  const dir = await scratchDir();
  const { session, topic, question } = await seedWaitingSession(dir);
  const runTurn = async (prompt) => {
    assert.match(prompt, /What is SN1\?/);
    assert.match(prompt, /It's a one-step substitution\./);
    return feedbackFence({ feedback: "Correct and concise.", rating: "good" });
  };

  const result = await submitLiveAnswer(dir, session.id, { answerText: "It's a one-step substitution.", confidence: 4 }, { runTurn });
  assert.equal(result.ok, true);
  assert.equal(result.session.status, "active");
  assert.equal(result.session.currentQuestion, null);
  assert.equal(result.session.history.length, 1);
  assert.deepEqual(result.session.history[0], {
    ...question,
    answerText: "It's a one-step substitution.",
    confidence: 4,
    rating: "good",
    feedback: "Correct and concise.",
    answeredAt: result.session.history[0].answeredAt,
  });
  assert.equal(typeof result.session.history[0].answeredAt, "string");

  const stored = await getSession(dir, session.id);
  assert.deepEqual(stored, result.session);

  const { listTopics } = await import("../topics.js");
  const [updatedTopic] = await listTopics(dir, topic.subjectId);
  assert.notEqual(updatedTopic.fsrs.reps, topic.fsrs.reps);
});

test("submitLiveAnswer includes stored preferences in the prompt sent to the model", async () => {
  const dir = await scratchDir();
  const { session } = await seedWaitingSession(dir);
  await addPreference(dir, { text: "always give a worked example after a miss" });
  let seenPrompt = "";
  const runTurn = async (prompt) => {
    seenPrompt = prompt;
    return feedbackFence({ feedback: "ok", rating: "good" });
  };
  await submitLiveAnswer(dir, session.id, { answerText: "an answer", confidence: 3 }, { runTurn });
  assert.match(seenPrompt, /worked example after a miss/);
});

test("submitLiveAnswer trims and bounds the answer text fed into the prompt", async () => {
  const dir = await scratchDir();
  const { session } = await seedWaitingSession(dir);
  let seenPrompt = "";
  const runTurn = async (prompt) => {
    seenPrompt = prompt;
    return feedbackFence({ feedback: "ok", rating: "good" });
  };
  await submitLiveAnswer(dir, session.id, { answerText: "  padded answer  ", confidence: 3 }, { runTurn });
  assert.match(seenPrompt, /"padded answer"/);
});

test("submitLiveAnswer leaves the session and topic untouched when the model call fails", async () => {
  const dir = await scratchDir();
  const { session, topic } = await seedWaitingSession(dir);
  const runTurn = async () => {
    throw new Error("claude exited with code 1: boom");
  };
  const result = await submitLiveAnswer(dir, session.id, { answerText: "an answer", confidence: 3 }, { runTurn });
  assert.equal(result.ok, false);
  assert.match(result.reason, /boom/);

  const stored = await getSession(dir, session.id);
  assert.equal(stored.status, "waiting");
  assert.notEqual(stored.currentQuestion, null);
  assert.deepEqual(stored.history, []);

  const { listTopics } = await import("../topics.js");
  const [unchangedTopic] = await listTopics(dir, topic.subjectId);
  assert.deepEqual(unchangedTopic.fsrs, topic.fsrs);
});

test("submitLiveAnswer leaves the session untouched when the reply doesn't parse", async () => {
  const dir = await scratchDir();
  const { session } = await seedWaitingSession(dir);
  const runTurn = async () => "no JSON here at all";
  const result = await submitLiveAnswer(dir, session.id, { answerText: "an answer", confidence: 3 }, { runTurn });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no readable grading result/);

  const stored = await getSession(dir, session.id);
  assert.equal(stored.status, "waiting");
  assert.deepEqual(stored.history, []);
});

test("submitLiveAnswer leaves the session untouched when the rating is invalid", async () => {
  const dir = await scratchDir();
  const { session } = await seedWaitingSession(dir);
  const runTurn = async () => feedbackFence({ feedback: "Hmm.", rating: "perfect" });
  const result = await submitLiveAnswer(dir, session.id, { answerText: "an answer", confidence: 3 }, { runTurn });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not one of/);

  const stored = await getSession(dir, session.id);
  assert.equal(stored.status, "waiting");
});

test("submitLiveAnswer rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => submitLiveAnswer(dir, "no-such-id", { answerText: "x", confidence: 3 }), /Session not found/);
});

test("submitLiveAnswer rejects a ready-mode session", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "History" });
  const [topic] = await addPlannedTopics(dir, subject.id, ["The French Revolution"]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await assert.rejects(
    () => submitLiveAnswer(dir, session.id, { answerText: "x", confidence: 3 }),
    /only applies to live-mode sessions/,
  );
});

test("submitLiveAnswer rejects a session with no current question", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir);
  await assert.rejects(
    () => submitLiveAnswer(dir, session.id, { answerText: "x", confidence: 3 }),
    /no current question to answer/,
  );
});

test("submitLiveAnswer rejects a blank answerText", async () => {
  const dir = await scratchDir();
  const { session } = await seedWaitingSession(dir);
  await assert.rejects(
    () => submitLiveAnswer(dir, session.id, { answerText: "   ", confidence: 3 }),
    /answerText must be a non-empty string/,
  );
});

test("submitLiveAnswer rejects a missing or out-of-range confidence", async () => {
  const dir = await scratchDir();
  const { session } = await seedWaitingSession(dir);
  await assert.rejects(
    () => submitLiveAnswer(dir, session.id, { answerText: "x", confidence: 0 }),
    /confidence must be an integer from 1 to 5/,
  );
  await assert.rejects(
    () => submitLiveAnswer(dir, session.id, { answerText: "x", confidence: 6 }),
    /confidence must be an integer from 1 to 5/,
  );
  await assert.rejects(
    () => submitLiveAnswer(dir, session.id, { answerText: "x", confidence: 3.5 }),
    /confidence must be an integer from 1 to 5/,
  );
  await assert.rejects(
    () => submitLiveAnswer(dir, session.id, { answerText: "x" }),
    /confidence must be an integer from 1 to 5/,
  );
});
