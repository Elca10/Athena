import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBankQuestions, addBankQuestions, getBankQuestionById, markQuestionShown } from "../questionBank.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-question-bank-"));
}

test("listBankQuestions starts empty for any topic id", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await listBankQuestions(dir, "topic-1"), []);
});

test("addBankQuestions stores rows with ids and seen-tracking bookkeeping", async () => {
  const dir = await scratchDir();
  const added = await addBankQuestions(dir, "topic-1", "subject-1", [
    {
      type: "short_answer",
      prompt: "What is a binary search tree?",
      difficulty: "intro",
      modelAnswer: "A tree where each node's left subtree is smaller and right subtree is larger.",
      rubric: ["mentions ordering property", "mentions subtrees"],
      misconceptions: ["confusing it with a heap"],
    },
  ]);
  assert.equal(added.length, 1);
  assert.equal(typeof added[0].id, "string");
  assert.equal(added[0].topicId, "topic-1");
  assert.equal(added[0].subjectId, "subject-1");
  assert.equal(added[0].seenCount, 0);
  assert.equal(added[0].lastShownAt, null);
  assert.equal(typeof added[0].createdAt, "string");

  const stored = await listBankQuestions(dir, "topic-1");
  assert.deepEqual(stored, added);
});

test("addBankQuestions keeps multiple_choice's choices/correctIndex and drops them for other types", async () => {
  const dir = await scratchDir();
  const [mc] = await addBankQuestions(dir, "topic-1", "subject-1", [
    {
      type: "multiple_choice",
      prompt: "Which is a stable sort?",
      difficulty: "medium",
      modelAnswer: "Merge sort.",
      rubric: [],
      misconceptions: [],
      choices: ["Quicksort", "Merge sort", "Heapsort"],
      correctIndex: 1,
    },
  ]);
  assert.deepEqual(mc.choices, ["Quicksort", "Merge sort", "Heapsort"]);
  assert.equal(mc.correctIndex, 1);

  const [shortAnswer] = await addBankQuestions(dir, "topic-2", "subject-1", [
    { type: "short_answer", prompt: "Explain recursion.", difficulty: "medium", modelAnswer: "A function calling itself.", rubric: ["base case"] },
  ]);
  assert.equal(shortAnswer.choices, undefined);
  assert.equal(shortAnswer.correctIndex, undefined);
});

test("addBankQuestions keeps cloze's clozeAnswer and drops it for other types", async () => {
  const dir = await scratchDir();
  const [cloze] = await addBankQuestions(dir, "topic-1", "subject-1", [
    { type: "cloze", prompt: "The powerhouse of the cell is the _____.", difficulty: "intro", modelAnswer: "mitochondria", rubric: [], clozeAnswer: "mitochondria" },
  ]);
  assert.equal(cloze.clozeAnswer, "mitochondria");

  const [mc] = await addBankQuestions(dir, "topic-2", "subject-1", [
    { type: "multiple_choice", prompt: "p", difficulty: "medium", modelAnswer: "a", rubric: [], choices: ["a", "b"], correctIndex: 0 },
  ]);
  assert.equal(mc.clozeAnswer, undefined);
});

test("addBankQuestions does nothing for an empty list", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await addBankQuestions(dir, "topic-1", "subject-1", []), []);
  assert.deepEqual(await listBankQuestions(dir, "topic-1"), []);
});

test("getBankQuestionById finds a question regardless of topic and returns null for an unknown id", async () => {
  const dir = await scratchDir();
  const [added] = await addBankQuestions(dir, "topic-1", "subject-1", [
    { type: "short_answer", prompt: "a", difficulty: "medium", modelAnswer: "a", rubric: ["x"] },
  ]);
  assert.deepEqual(await getBankQuestionById(dir, added.id), added);
  assert.equal(await getBankQuestionById(dir, "no-such-id"), null);
});

test("markQuestionShown increments seenCount and stamps lastShownAt", async () => {
  const dir = await scratchDir();
  const [added] = await addBankQuestions(dir, "topic-1", "subject-1", [
    { type: "short_answer", prompt: "a", difficulty: "medium", modelAnswer: "a", rubric: ["x"] },
  ]);
  const once = await markQuestionShown(dir, added.id, new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(once.seenCount, 1);
  assert.equal(once.lastShownAt, "2026-01-01T00:00:00.000Z");
  const twice = await markQuestionShown(dir, added.id, new Date("2026-02-01T00:00:00.000Z"));
  assert.equal(twice.seenCount, 2);
  assert.equal(twice.lastShownAt, "2026-02-01T00:00:00.000Z");
});

test("markQuestionShown rejects an unknown id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => markQuestionShown(dir, "no-such-id"), /Bank question not found/);
});

test("listBankQuestions only returns questions for the requested topic", async () => {
  const dir = await scratchDir();
  await addBankQuestions(dir, "topic-1", "subject-1", [
    { type: "short_answer", prompt: "a", difficulty: "medium", modelAnswer: "a", rubric: ["x"] },
  ]);
  await addBankQuestions(dir, "topic-2", "subject-1", [
    { type: "short_answer", prompt: "b", difficulty: "medium", modelAnswer: "b", rubric: ["x"] },
  ]);
  const topic1 = await listBankQuestions(dir, "topic-1");
  assert.equal(topic1.length, 1);
  assert.equal(topic1[0].prompt, "a");
});
