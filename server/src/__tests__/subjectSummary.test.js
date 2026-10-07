import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubject } from "../subjects.js";
import { addPlannedTopics, recordTopicReview } from "../topics.js";
import { addBankQuestions } from "../questionBank.js";
import { computeMasteryCounts, getSubjectSummary } from "../subjectSummary.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-subject-summary-"));
}

function fakeTopic(state) {
  return { fsrs: { state } };
}

test("computeMasteryCounts buckets New/Learning/Review/Relearning into new/learning/mastered", () => {
  const topics = [fakeTopic(0), fakeTopic(1), fakeTopic(2), fakeTopic(3), fakeTopic(0)];
  assert.deepEqual(computeMasteryCounts(topics), { new: 2, learning: 2, mastered: 1 });
});

test("computeMasteryCounts treats a missing fsrs state as new", () => {
  assert.deepEqual(computeMasteryCounts([{}]), { new: 1, learning: 0, mastered: 0 });
});

test("getSubjectSummary on a subject with no topics returns all-zero counts", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "Empty Subject" });
  assert.deepEqual(await getSubjectSummary(dir, subject.id), {
    masteryCounts: { new: 0, learning: 0, mastered: 0 },
    dueCount: 0,
    bankSize: 0,
  });
});

test("getSubjectSummary counts due topics and bank questions across a subject's topics", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "Chemistry" });
  const [t1, t2] = await addPlannedTopics(dir, subject.id, ["Topic 1", "Topic 2"]);

  // t1 is new (never reviewed) -> still due, state New; t2 reviewed "good"
  // -> state advances out of New, and the review moves its due date out.
  await recordTopicReview(dir, t2.id, "good");

  await addBankQuestions(dir, t1.id, subject.id, [
    { type: "free_recall", prompt: "p1", difficulty: "intro", modelAnswer: "a1", rubric: ["r1"] },
  ]);
  await addBankQuestions(dir, t2.id, subject.id, [
    { type: "free_recall", prompt: "p2", difficulty: "intro", modelAnswer: "a2", rubric: ["r2"] },
    { type: "free_recall", prompt: "p3", difficulty: "intro", modelAnswer: "a3", rubric: ["r3"] },
  ]);

  const summary = await getSubjectSummary(dir, subject.id);
  assert.equal(summary.bankSize, 3);
  assert.equal(summary.masteryCounts.new, 1);
  assert.equal(summary.masteryCounts.new + summary.masteryCounts.learning + summary.masteryCounts.mastered, 2);
  // t1 is still due immediately; t2's due date moved into the future after
  // a "good" review, so only t1 should count as due right now.
  assert.equal(summary.dueCount, 1);
});

test("getSubjectSummary is scoped to its own subject, not any other subject's topics", async () => {
  const dir = await scratchDir();
  const subjectA = await createSubject(dir, { name: "A" });
  const subjectB = await createSubject(dir, { name: "B" });
  await addPlannedTopics(dir, subjectA.id, ["A topic"]);
  await addPlannedTopics(dir, subjectB.id, ["B topic 1", "B topic 2"]);

  const summaryA = await getSubjectSummary(dir, subjectA.id);
  const summaryB = await getSubjectSummary(dir, subjectB.id);
  assert.equal(summaryA.dueCount, 1);
  assert.equal(summaryB.dueCount, 2);
});
