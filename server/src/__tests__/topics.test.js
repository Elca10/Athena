import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTopics, addPlannedTopics, normalizeTopicName } from "../topics.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-topics-"));
}

test("listTopics starts empty for any subject id", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await listTopics(dir, "subject-1"), []);
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
