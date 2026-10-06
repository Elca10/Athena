import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addPlannedTopics, recordTopicReview } from "../topics.js";
import { buildSessionTopicIds, MAX_SESSION_TOPICS } from "../sessionBuilder.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-session-builder-"));
}

test("buildSessionTopicIds returns nothing for an empty subject list", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await buildSessionTopicIds(dir, []), []);
});

test("buildSessionTopicIds returns nothing when a subject has no topics", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await buildSessionTopicIds(dir, ["subject-1"]), []);
});

test("buildSessionTopicIds returns a single subject's due topics, newly-seeded topics included (always due)", async () => {
  const dir = await scratchDir();
  const added = await addPlannedTopics(dir, "subject-1", ["A", "B", "C"]);
  const topicIds = await buildSessionTopicIds(dir, ["subject-1"]);
  assert.deepEqual(topicIds.sort(), added.map((t) => t.id).sort());
});

test("buildSessionTopicIds excludes a topic reviewed as 'good' (no longer due)", async () => {
  const dir = await scratchDir();
  const [a, b] = await addPlannedTopics(dir, "subject-1", ["A", "B"]);
  await recordTopicReview(dir, a.id, "good");
  const topicIds = await buildSessionTopicIds(dir, ["subject-1"]);
  assert.deepEqual(topicIds, [b.id]);
});

test("buildSessionTopicIds interleaves round-robin across multiple subjects", async () => {
  const dir = await scratchDir();
  const s1 = await addPlannedTopics(dir, "subject-1", ["A1", "A2", "A3"]);
  const s2 = await addPlannedTopics(dir, "subject-2", ["B1", "B2"]);
  const topicIds = await buildSessionTopicIds(dir, ["subject-1", "subject-2"]);
  // One from each subject per pass: s1[0], s2[0], s1[1], s2[1], s1[2]
  // (subject-2 runs out after its 2 topics, subject-1 keeps contributing).
  assert.deepEqual(topicIds, [s1[0].id, s2[0].id, s1[1].id, s2[1].id, s1[2].id]);
});

test("buildSessionTopicIds caps at the given limit", async () => {
  const dir = await scratchDir();
  const s1 = await addPlannedTopics(dir, "subject-1", ["A1", "A2", "A3"]);
  const topicIds = await buildSessionTopicIds(dir, ["subject-1"], { limit: 2 });
  assert.deepEqual(topicIds, [s1[0].id, s1[1].id]);
});

test("buildSessionTopicIds defaults to MAX_SESSION_TOPICS, not unbounded", async () => {
  const dir = await scratchDir();
  const names = Array.from({ length: MAX_SESSION_TOPICS + 5 }, (_, i) => `Topic ${i}`);
  await addPlannedTopics(dir, "subject-1", names);
  const topicIds = await buildSessionTopicIds(dir, ["subject-1"]);
  assert.equal(topicIds.length, MAX_SESSION_TOPICS);
});

test("buildSessionTopicIds de-duplicates a repeated subject id in the input", async () => {
  const dir = await scratchDir();
  const s1 = await addPlannedTopics(dir, "subject-1", ["A1", "A2"]);
  const topicIds = await buildSessionTopicIds(dir, ["subject-1", "subject-1"]);
  assert.deepEqual(topicIds.sort(), s1.map((t) => t.id).sort());
});
