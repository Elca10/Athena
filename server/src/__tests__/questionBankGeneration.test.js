import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addUploadedContent } from "../content.js";
import { addPlannedTopics, listTopics, markBankGenerated } from "../topics.js";
import { listBankQuestions, addBankQuestions } from "../questionBank.js";
import { addPreference } from "../preferences.js";
import {
  buildBankPrompt,
  parseBankReply,
  scanSubjectForBankGeneration,
  topUpTopicBank,
  runBankGenerationTurn,
  MAX_TOPICS_PER_BATCH,
  QUESTIONS_PER_TOPIC,
} from "../questionBankGeneration.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-bank-generation-"));
}

// Same technique topicExtraction.test.js uses to make "claude not found"
// deterministic regardless of whether this machine happens to have the
// real CLI installed.
function emptyPathEnv() {
  return { PATH: os.tmpdir() };
}

function validQuestion(overrides = {}) {
  return {
    type: "short_answer",
    prompt: "What is a binary search tree?",
    difficulty: "medium",
    modelAnswer: "A tree where each node's left subtree is smaller and right is larger.",
    rubric: ["mentions the ordering property"],
    misconceptions: ["confusing it with a heap"],
    ...overrides,
  };
}

function bankReply(topics) {
  return "```json athena-question-bank\n" + JSON.stringify({ topics, summary: "ok" }) + "\n```";
}

// --- buildBankPrompt --------------------------------------------------------

test("buildBankPrompt names the subject, lists topics with notes, and points at file paths", () => {
  const prompt = buildBankPrompt({
    subjectName: "Discrete Math",
    topics: [{ name: "Graphs", notes: "adjacency lists" }, { name: "Trees" }],
    files: [{ absolutePath: "/tmp/a.md" }],
  });
  assert.match(prompt, /Discrete Math/);
  assert.match(prompt, /"Graphs" — adjacency lists/);
  assert.match(prompt, /"Trees"/);
  assert.match(prompt, /\/tmp\/a\.md/);
});

test("buildBankPrompt says no material is available when there are no files", () => {
  const prompt = buildBankPrompt({ subjectName: "Biology", topics: [{ name: "Osmosis" }], files: [] });
  assert.match(prompt, /No uploaded material is available/i);
});

test("buildBankPrompt mentions the requested question count", () => {
  const prompt = buildBankPrompt({ subjectName: "Biology", topics: [{ name: "Osmosis" }], files: [], questionsPerTopic: 3 });
  assert.match(prompt, /exactly 3 questions/);
});

test("buildBankPrompt appends stored preferences when given any", () => {
  const prompt = buildBankPrompt({
    subjectName: "Biology",
    topics: [{ name: "Osmosis" }],
    files: [],
    preferences: [{ text: "harder questions on proofs" }],
  });
  assert.match(prompt, /standing study preferences/);
  assert.match(prompt, /harder questions on proofs/);
});

// --- parseBankReply ----------------------------------------------------------

test("parseBankReply reads the tagged fence and normalizes a valid question", () => {
  const reply = bankReply([{ topicName: "Binary search trees", questions: [validQuestion()] }]);
  const result = parseBankReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.topics.length, 1);
  assert.equal(result.topics[0].topicName, "Binary search trees");
  assert.equal(result.topics[0].questions.length, 1);
  assert.equal(result.topics[0].questions[0].prompt, validQuestion().prompt);
});

test("parseBankReply falls back to a plain fence when the tag is missing", () => {
  const reply = "```\n" + JSON.stringify({ topics: [{ topicName: "Stacks", questions: [validQuestion()] }] }) + "\n```";
  const result = parseBankReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.topics[0].topicName, "Stacks");
});

test("parseBankReply prefers the LAST fence, so a restated example isn't parsed", () => {
  const example = bankReply([{ topicName: "EXAMPLE", questions: [validQuestion()] }]);
  const real = bankReply([{ topicName: "Queues", questions: [validQuestion()] }]);
  const result = parseBankReply(`Here's the format:\n${example}\n\nMy actual answer:\n${real}`);
  assert.equal(result.ok, true);
  assert.equal(result.topics.length, 1);
  assert.equal(result.topics[0].topicName, "Queues");
});

test("parseBankReply rejects an empty reply", () => {
  assert.equal(parseBankReply("").ok, false);
  assert.equal(parseBankReply("   ").ok, false);
});

test("parseBankReply rejects a reply with no fenced JSON at all", () => {
  const result = parseBankReply("I thought about it but didn't format anything.");
  assert.equal(result.ok, false);
});

test("parseBankReply drops a question with an unknown type but keeps the rest", () => {
  const reply = bankReply([
    { topicName: "Stacks", questions: [validQuestion({ type: "essay" }), validQuestion({ prompt: "second" })] },
  ]);
  const result = parseBankReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.topics[0].questions.length, 1);
  assert.equal(result.topics[0].questions[0].prompt, "second");
});

test("parseBankReply drops a self-graded-type question with an empty rubric", () => {
  const reply = bankReply([{ topicName: "Stacks", questions: [validQuestion({ rubric: [] })] }]);
  const result = parseBankReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.topics[0].questions.length, 0);
});

test("parseBankReply accepts a multiple_choice question with valid choices/correctIndex", () => {
  const reply = bankReply([
    {
      topicName: "Sorting",
      questions: [
        validQuestion({ type: "multiple_choice", rubric: [], choices: ["Quicksort", "Merge sort", "Heapsort"], correctIndex: 1 }),
      ],
    },
  ]);
  const result = parseBankReply(reply);
  assert.equal(result.topics[0].questions.length, 1);
  assert.deepEqual(result.topics[0].questions[0].choices, ["Quicksort", "Merge sort", "Heapsort"]);
  assert.equal(result.topics[0].questions[0].correctIndex, 1);
});

test("parseBankReply drops a multiple_choice question with fewer than two choices or an out-of-range correctIndex", () => {
  const tooFewChoices = bankReply([
    { topicName: "Sorting", questions: [validQuestion({ type: "multiple_choice", rubric: [], choices: ["only one"], correctIndex: 0 })] },
  ]);
  assert.equal(parseBankReply(tooFewChoices).topics[0].questions.length, 0);

  const badIndex = bankReply([
    {
      topicName: "Sorting",
      questions: [validQuestion({ type: "multiple_choice", rubric: [], choices: ["a", "b"], correctIndex: 5 })],
    },
  ]);
  assert.equal(parseBankReply(badIndex).topics[0].questions.length, 0);
});

test("parseBankReply accepts a cloze question with a clozeAnswer and drops one without", () => {
  const withAnswer = bankReply([
    { topicName: "Biology", questions: [validQuestion({ type: "cloze", rubric: [], clozeAnswer: "mitochondria" })] },
  ]);
  assert.equal(parseBankReply(withAnswer).topics[0].questions.length, 1);
  assert.equal(parseBankReply(withAnswer).topics[0].questions[0].clozeAnswer, "mitochondria");

  const withoutAnswer = bankReply([{ topicName: "Biology", questions: [validQuestion({ type: "cloze", rubric: [] })] }]);
  assert.equal(parseBankReply(withoutAnswer).topics[0].questions.length, 0);
});

test("parseBankReply drops a question with a blank prompt or model answer", () => {
  const reply = bankReply([
    {
      topicName: "Stacks",
      questions: [validQuestion({ prompt: "   " }), validQuestion({ modelAnswer: "" }), validQuestion({ prompt: "kept" })],
    },
  ]);
  const result = parseBankReply(reply);
  assert.equal(result.topics[0].questions.length, 1);
  assert.equal(result.topics[0].questions[0].prompt, "kept");
});

test("parseBankReply defaults an invalid difficulty to medium rather than rejecting the question", () => {
  const reply = bankReply([{ topicName: "Stacks", questions: [validQuestion({ difficulty: "impossible" })] }]);
  const result = parseBankReply(reply);
  assert.equal(result.topics[0].questions[0].difficulty, "medium");
});

test("parseBankReply skips a topic entry with a blank topicName", () => {
  const reply = bankReply([{ topicName: "  ", questions: [validQuestion()] }, { topicName: "Real topic", questions: [validQuestion()] }]);
  const result = parseBankReply(reply);
  assert.equal(result.topics.length, 1);
  assert.equal(result.topics[0].topicName, "Real topic");
});

test("parseBankReply reports failure when there are no usable topics at all", () => {
  const reply = bankReply([{ topicName: "", questions: [] }]);
  assert.equal(parseBankReply(reply).ok, false);
});

// --- runBankGenerationTurn ---------------------------------------------------

test("runBankGenerationTurn rejects with a clear error when the claude CLI can't be found", async () => {
  await assert.rejects(() => runBankGenerationTurn("irrelevant prompt", { env: emptyPathEnv() }), (err) => {
    assert.ok(err.notFound || /ENOENT/.test(err.message));
    return true;
  });
});

// --- scanSubjectForBankGeneration (the orchestration) ------------------------

test("scanSubjectForBankGeneration does nothing when no topic needs a bank", async () => {
  const dir = await scratchDir();
  const result = await scanSubjectForBankGeneration(dir, "subject-1", { subjectName: "Empty Subject" });
  assert.deepEqual(result, { ok: true, skipped: false, topicsProcessed: 0, questionsAdded: 0, errors: [] });
});

test("scanSubjectForBankGeneration generates a bank per topic, grounded in the subject's content files, and marks topics done", async () => {
  const dir = await scratchDir();
  const contentItem = await addUploadedContent(dir, "subject-1", { filename: "lecture1.md", text: "# BSTs" });
  const [topic1, topic2] = await addPlannedTopics(dir, "subject-1", [
    { name: "Binary search trees", notes: "balance, rotation" },
    { name: "Hash tables" },
  ]);

  const prompts = [];
  const fakeTurn = async (prompt) => {
    prompts.push(prompt);
    return bankReply([
      { topicName: "Binary search trees", questions: [validQuestion()] },
      { topicName: "Hash tables", questions: [validQuestion({ prompt: "What is a hash collision?" })] },
    ]);
  };

  const result = await scanSubjectForBankGeneration(dir, "subject-1", { subjectName: "CS 101", runTurn: fakeTurn });
  assert.equal(result.ok, true);
  assert.equal(result.topicsProcessed, 2);
  assert.equal(result.questionsAdded, 2);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /CS 101/);
  assert.match(prompts[0], /Binary search trees/);
  assert.match(prompts[0], /Hash tables/);
  assert.match(prompts[0], new RegExp(contentItem.id));

  const stored = await listTopics(dir, "subject-1");
  assert.ok(stored.every((t) => typeof t.bankGeneratedAt === "string"));

  assert.equal((await listBankQuestions(dir, topic1.id)).length, 1);
  assert.equal((await listBankQuestions(dir, topic2.id)).length, 1);
});

test("scanSubjectForBankGeneration includes stored preferences in the prompt sent to the model", async () => {
  const dir = await scratchDir();
  await addPlannedTopics(dir, "subject-1", ["Recursion"]);
  await addPreference(dir, { text: "harder questions on proofs" });

  let seenPrompt = null;
  const fakeTurn = async (prompt) => {
    seenPrompt = prompt;
    return bankReply([{ topicName: "Recursion", questions: [validQuestion()] }]);
  };
  await scanSubjectForBankGeneration(dir, "subject-1", { subjectName: "S", runTurn: fakeTurn });
  assert.match(seenPrompt, /harder questions on proofs/);
});

test("scanSubjectForBankGeneration batches topics past MAX_TOPICS_PER_BATCH into separate turns", async () => {
  const dir = await scratchDir();
  const names = Array.from({ length: MAX_TOPICS_PER_BATCH + 1 }, (_, i) => `Topic ${i}`);
  await addPlannedTopics(dir, "subject-1", names);

  let calls = 0;
  const fakeTurn = async (prompt) => {
    calls += 1;
    const topicNames = [...prompt.matchAll(/"(Topic \d+)"/g)].map((m) => m[1]);
    return bankReply(topicNames.map((topicName) => ({ topicName, questions: [validQuestion()] })));
  };

  const result = await scanSubjectForBankGeneration(dir, "subject-1", { subjectName: "S", runTurn: fakeTurn });
  assert.equal(calls, 2);
  assert.equal(result.topicsProcessed, MAX_TOPICS_PER_BATCH + 1);
});

test("scanSubjectForBankGeneration never re-sends a topic that already has a bank", async () => {
  const dir = await scratchDir();
  await addPlannedTopics(dir, "subject-1", ["Recursion"]);

  let calls = 0;
  const fakeTurn = async () => {
    calls += 1;
    return bankReply([{ topicName: "Recursion", questions: [validQuestion()] }]);
  };

  await scanSubjectForBankGeneration(dir, "subject-1", { subjectName: "S", runTurn: fakeTurn });
  const second = await scanSubjectForBankGeneration(dir, "subject-1", { subjectName: "S", runTurn: fakeTurn });
  assert.equal(calls, 1);
  assert.equal(second.topicsProcessed, 0);
});

test("scanSubjectForBankGeneration leaves a batch's topics unmarked when the turn throws", async () => {
  const dir = await scratchDir();
  const [topic] = await addPlannedTopics(dir, "subject-1", ["Recursion"]);

  const failingTurn = async () => {
    throw new Error("claude CLI not found");
  };
  const result = await scanSubjectForBankGeneration(dir, "subject-1", { subjectName: "S", runTurn: failingTurn });
  assert.equal(result.ok, false);
  assert.equal(result.topicsProcessed, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /claude CLI not found/);

  const stored = await listTopics(dir, "subject-1");
  assert.equal(stored.find((t) => t.id === topic.id).bankGeneratedAt, null);
});

test("scanSubjectForBankGeneration leaves a topic unmarked when the reply omits it or gives it no usable questions", async () => {
  const dir = await scratchDir();
  const [covered, missing, emptyOnes] = await addPlannedTopics(dir, "subject-1", ["Covered", "Missing", "Empty"]);

  const fakeTurn = async () =>
    bankReply([
      { topicName: "Covered", questions: [validQuestion()] },
      { topicName: "Empty", questions: [] },
      // "Missing" is simply never mentioned in the reply.
    ]);

  const result = await scanSubjectForBankGeneration(dir, "subject-1", { subjectName: "S", runTurn: fakeTurn });
  assert.equal(result.topicsProcessed, 1);
  assert.equal(result.errors.length, 2);

  const stored = await listTopics(dir, "subject-1");
  assert.equal(typeof stored.find((t) => t.id === covered.id).bankGeneratedAt, "string");
  assert.equal(stored.find((t) => t.id === missing.id).bankGeneratedAt, null);
  assert.equal(stored.find((t) => t.id === emptyOnes.id).bankGeneratedAt, null);
});

test("scanSubjectForBankGeneration falls back to 'no material available' framing when no content has been parsed yet", async () => {
  const dir = await scratchDir();
  await addPlannedTopics(dir, "subject-1", ["Recursion"]);

  let seenPrompt = null;
  const fakeTurn = async (prompt) => {
    seenPrompt = prompt;
    return bankReply([{ topicName: "Recursion", questions: [validQuestion()] }]);
  };
  await scanSubjectForBankGeneration(dir, "subject-1", { subjectName: "S", runTurn: fakeTurn });
  assert.match(seenPrompt, /No uploaded material is available/i);
});

test("QUESTIONS_PER_TOPIC is a small positive number", () => {
  assert.ok(Number.isInteger(QUESTIONS_PER_TOPIC) && QUESTIONS_PER_TOPIC > 0 && QUESTIONS_PER_TOPIC <= 10);
});

// --- topUpTopicBank -----------------------------------------------------

test("topUpTopicBank adds more questions to an already-generated topic without touching bankGeneratedAt", async () => {
  const dir = await scratchDir();
  const [topic] = await addPlannedTopics(dir, "subject-1", ["Recursion"]);
  await addBankQuestions(dir, topic.id, "subject-1", [validQuestion()]); // simulates an already-generated bank
  await markBankGenerated(dir, [topic.id]);
  const [{ bankGeneratedAt }] = await listTopics(dir, "subject-1");

  const fakeTurn = async (prompt) => {
    assert.match(prompt, /Recursion/);
    return bankReply([{ topicName: "Recursion", questions: [validQuestion({ prompt: "a fresh angle" })] }]);
  };
  const result = await topUpTopicBank(dir, topic.id, { subjectName: "CS 101", runTurn: fakeTurn });
  assert.equal(result.ok, true);
  assert.equal(result.questionsAdded, 1);

  const stored = await listBankQuestions(dir, topic.id);
  assert.equal(stored.length, 2);
  const [afterTopUp] = await listTopics(dir, "subject-1");
  assert.equal(afterTopUp.bankGeneratedAt, bankGeneratedAt);
});

test("topUpTopicBank rejects an unknown topic id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => topUpTopicBank(dir, "no-such-id", { subjectName: "S" }), /Topic not found/);
});

test("topUpTopicBank reports a turn failure without throwing", async () => {
  const dir = await scratchDir();
  const [topic] = await addPlannedTopics(dir, "subject-1", ["Recursion"]);
  const failingTurn = async () => {
    throw new Error("claude CLI not found");
  };
  const result = await topUpTopicBank(dir, topic.id, { subjectName: "S", runTurn: failingTurn });
  assert.equal(result.ok, false);
  assert.equal(result.questionsAdded, 0);
  assert.match(result.errors[0], /claude CLI not found/);
});
