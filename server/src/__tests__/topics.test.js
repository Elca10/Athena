import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTopics, getTopicById, addPlannedTopics, normalizeTopicName, listDueTopics, recordTopicReview } from "../topics.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-topics-"));
}

test("listTopics starts empty for any subject id", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await listTopics(dir, "subject-1"), []);
});

test("getTopicById finds a topic regardless of which subject it belongs to", async () => {
  const dir = await scratchDir();
  const [topic] = await addPlannedTopics(dir, "subject-1", ["Recursion"]);
  assert.deepEqual(await getTopicById(dir, topic.id), topic);
});

test("getTopicById returns null for an unknown id", async () => {
  const dir = await scratchDir();
  assert.equal(await getTopicById(dir, "no-such-topic"), null);
});

test("addPlannedTopics stores new topics with ids and names trimmed", async () => {
  const dir = await scratchDir();
  const added = await addPlannedTopics(dir, "subject-1", [
    { name: "  Binary search trees  ", notes: "balance, rotation" },
    "Hash tables",
  ]);
  assert.equal(added.length, 2);
  assert.equal(added[0].name, "Binary search trees");
  assert.equal(added[0].notes, "balance, rotation");
  assert.equal(added[1].name, "Hash tables");
  assert.equal(added[1].notes, "");
  assert.equal(typeof added[0].id, "string");
  assert.equal(typeof added[0].createdAt, "string");

  const stored = await listTopics(dir, "subject-1");
  assert.equal(stored.length, 2);
});

test("addPlannedTopics skips a topic whose normalized name already exists for the subject", async () => {
  const dir = await scratchDir();
  await addPlannedTopics(dir, "subject-1", ["Recursion"]);
  const secondBatch = await addPlannedTopics(dir, "subject-1", ["  recursion  ", "Iteration"]);
  assert.equal(secondBatch.length, 1);
  assert.equal(secondBatch[0].name, "Iteration");
  assert.equal((await listTopics(dir, "subject-1")).length, 2);
});

test("addPlannedTopics skips duplicates within the same call", async () => {
  const dir = await scratchDir();
  const added = await addPlannedTopics(dir, "subject-1", ["Photosynthesis", "PHOTOSYNTHESIS", "Photosynthesis "]);
  assert.equal(added.length, 1);
});

test("addPlannedTopics skips blank names", async () => {
  const dir = await scratchDir();
  const added = await addPlannedTopics(dir, "subject-1", ["  ", "", "Valid topic"]);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, "Valid topic");
});

test("a topic with the same name is independent across different subjects", async () => {
  const dir = await scratchDir();
  await addPlannedTopics(dir, "subject-1", ["Osmosis"]);
  const added = await addPlannedTopics(dir, "subject-2", ["Osmosis"]);
  assert.equal(added.length, 1);
  assert.equal((await listTopics(dir, "subject-1")).length, 1);
  assert.equal((await listTopics(dir, "subject-2")).length, 1);
});

test("normalizeTopicName collapses whitespace and case", () => {
  assert.equal(normalizeTopicName("  Binary   Search Trees "), "binary search trees");
  assert.equal(normalizeTopicName(null), "");
});

test("a newly added topic has an FSRS card state and is immediately due", async () => {
  const dir = await scratchDir();
  const [topic] = await addPlannedTopics(dir, "subject-1", ["Recursion"]);
  assert.equal(typeof topic.fsrs, "object");
  assert.equal(typeof topic.fsrs.due, "number");
  const due = await listDueTopics(dir, "subject-1");
  assert.deepEqual(due.map((t) => t.id), [topic.id]);
});

test("recordTopicReview updates the topic's fsrs state and stamps lastReviewedAt, leaving other topics untouched", async () => {
  const dir = await scratchDir();
  const [reviewed, other] = await addPlannedTopics(dir, "subject-1", ["Recursion", "Iteration"]);
  const updated = await recordTopicReview(dir, reviewed.id, "good");
  assert.ok(updated.fsrs.due > reviewed.fsrs.due);
  assert.equal(typeof updated.lastReviewedAt, "string");

  const stored = await listTopics(dir, "subject-1");
  const storedOther = stored.find((t) => t.id === other.id);
  assert.deepEqual(storedOther.fsrs, other.fsrs);
  assert.equal(storedOther.lastReviewedAt, undefined);
});

test("recordTopicReview rejects an unknown topic id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => recordTopicReview(dir, "no-such-topic", "good"), /Topic not found/);
});

test("recordTopicReview rejects an unknown rating and leaves the topic unchanged", async () => {
  const dir = await scratchDir();
  const [topic] = await addPlannedTopics(dir, "subject-1", ["Recursion"]);
  await assert.rejects(() => recordTopicReview(dir, topic.id, "amazing"), /Unknown rating/);
  const stored = await listTopics(dir, "subject-1");
  assert.deepEqual(stored.find((t) => t.id === topic.id).fsrs, topic.fsrs);
});

test("a reviewed topic with a future due date drops out of listDueTopics until it's due again", async () => {
  const dir = await scratchDir();
  const [topic] = await addPlannedTopics(dir, "subject-1", ["Recursion"]);
  await recordTopicReview(dir, topic.id, "good");
  assert.deepEqual(await listDueTopics(dir, "subject-1"), []);
});
