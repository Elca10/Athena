import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubject } from "../subjects.js";
import { addPlannedTopics, listTopics, recordTopicReview } from "../topics.js";
import { createSession, getSession } from "../sessions.js";
import {
  buildFirstQuestionPrompt,
  parseFirstQuestionReply,
  generateFirstLiveQuestion,
  runFirstQuestionTurn,
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

// --- generateFirstLiveQuestion (the orchestration) --------------------------

test("generateFirstLiveQuestion stores the question and moves the session to waiting", async () => {
  const dir = await scratchDir();
  const { session, topic, subject } = await seedSession(dir);
  const runTurn = async (prompt) => {
    assert.match(prompt, /SN1 vs SN2/);
    return fence({ prompt: "What do you think SN1 means?", type: "free_recall", difficulty: "intro" });
  };

  const result = await generateFirstLiveQuestion(dir, session.id, { runTurn });
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

test("generateFirstLiveQuestion frames a reviewed topic differently from a brand-new one", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir, { reviewed: true });
  let seenPrompt = "";
  const runTurn = async (prompt) => {
    seenPrompt = prompt;
    return fence({ prompt: "Explain why SN1 is favored here.", type: "explain_why", difficulty: "medium" });
  };
  await generateFirstLiveQuestion(dir, session.id, { runTurn });
  assert.match(seenPrompt, /reviewed this topic before/);
});

test("generateFirstLiveQuestion leaves the session untouched when the model call fails", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir);
  const runTurn = async () => {
    throw new Error("claude exited with code 1: boom");
  };
  const result = await generateFirstLiveQuestion(dir, session.id, { runTurn });
  assert.equal(result.ok, false);
  assert.match(result.reason, /boom/);

  const stored = await getSession(dir, session.id);
  assert.equal(stored.status, "active");
  assert.equal(stored.currentQuestion, null);
});

test("generateFirstLiveQuestion leaves the session untouched when the reply doesn't parse", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir);
  const runTurn = async () => "no JSON here at all";
  const result = await generateFirstLiveQuestion(dir, session.id, { runTurn });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no readable question/);

  const stored = await getSession(dir, session.id);
  assert.equal(stored.status, "active");
  assert.equal(stored.currentQuestion, null);
});

test("generateFirstLiveQuestion rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => generateFirstLiveQuestion(dir, "no-such-id"), /Session not found/);
});

test("generateFirstLiveQuestion rejects a ready-mode session", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "History" });
  const [topic] = await addPlannedTopics(dir, subject.id, ["The French Revolution"]);
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
  await assert.rejects(() => generateFirstLiveQuestion(dir, session.id), /only applies to live-mode sessions/);
});

test("generateFirstLiveQuestion rejects a session with no topics", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "History" });
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "live" });
  await assert.rejects(() => generateFirstLiveQuestion(dir, session.id), /no topics to ask about/);
});

test("generateFirstLiveQuestion refuses to overwrite an existing current question", async () => {
  const dir = await scratchDir();
  const { session } = await seedSession(dir);
  const runTurn = async () => fence({ prompt: "First one", type: "free_recall", difficulty: "intro" });
  await generateFirstLiveQuestion(dir, session.id, { runTurn });
  await assert.rejects(() => generateFirstLiveQuestion(dir, session.id, { runTurn }), /already has a current question/);
});
