import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "../testHelpers/tempDir.js";
import { createSubject } from "../subjects.js";
import { addPlannedTopics, removeContentFromTopics } from "../topics.js";
import {
  listDeadlines,
  listAllDeadlines,
  createDeadline,
  updateDeadline,
  deleteDeadline,
  coveredTopicIds,
  nextDeadline,
  DeadlineNotFoundError,
  MAX_DEADLINE_TITLE_LENGTH,
} from "../deadlines.js";
import { getSubjectSummary } from "../subjectSummary.js";

async function scratch() {
  const dir = await makeTempDir("athena-deadlines-");
  const subject = await createSubject(dir, { name: "Biology" });
  return { dir, subject };
}

test("no deadlines file means no deadlines (existing installs need no migration)", async () => {
  const { dir, subject } = await scratch();
  assert.deepEqual(await listDeadlines(dir, subject.id), []);
  assert.deepEqual(await listAllDeadlines(dir), []);
});

test("create, list (soonest first), update and delete a deadline", async () => {
  const { dir, subject } = await scratch();
  const [cells] = await addPlannedTopics(dir, subject.id, ["Cells", "Genetics"]);
  const final = await createDeadline(dir, subject.id, { title: "  Final   exam ", date: "2026-12-15" });
  const mid = await createDeadline(dir, subject.id, { title: "Midterm", date: "2026-11-02", topicIds: [cells.id, cells.id] });
  assert.equal(final.title, "Final exam");
  assert.equal(final.studying, true, "studying for it is the default");
  assert.equal(final.source, "manual");
  assert.deepEqual(final.topicIds, []);
  assert.deepEqual(mid.topicIds, [cells.id], "duplicates dropped");
  assert.deepEqual((await listDeadlines(dir, subject.id)).map((d) => d.title), ["Midterm", "Final exam"]);

  const updated = await updateDeadline(dir, subject.id, mid.id, { studying: false, date: "2026-11-03" });
  assert.equal(updated.studying, false);
  assert.equal(updated.date, "2026-11-03");
  assert.equal(updated.title, "Midterm", "fields not sent are left alone");

  await deleteDeadline(dir, subject.id, mid.id);
  assert.deepEqual((await listDeadlines(dir, subject.id)).map((d) => d.id), [final.id]);
});

test("invalid deadlines are refused with a reason a student can act on", async () => {
  const { dir, subject } = await scratch();
  await assert.rejects(createDeadline(dir, subject.id, { title: " ", date: "2026-11-02" }), /title/);
  await assert.rejects(createDeadline(dir, subject.id, { title: "x".repeat(MAX_DEADLINE_TITLE_LENGTH + 1), date: "2026-11-02" }), /at most/);
  await assert.rejects(createDeadline(dir, subject.id, { title: "Quiz", date: "2026-02-30" }), /valid date/);
  await assert.rejects(createDeadline(dir, subject.id, { title: "Quiz", date: "11/02/2026" }), /valid date/);
  await assert.rejects(createDeadline(dir, subject.id, { title: "Quiz", date: "2026-11-02", topicIds: ["nope"] }), /no longer exist/);
  await assert.rejects(createDeadline(dir, subject.id, { title: "Quiz", date: "2026-11-02", topicIds: "all" }), /list/);
  const d = await createDeadline(dir, subject.id, { title: "Quiz", date: "2026-11-02" });
  await assert.rejects(updateDeadline(dir, subject.id, d.id, { studying: "yes" }), /true or false/);
  await assert.rejects(updateDeadline(dir, subject.id, "missing", { title: "x" }), DeadlineNotFoundError);
  await assert.rejects(deleteDeadline(dir, "other-subject", d.id), DeadlineNotFoundError);
  assert.equal((await listDeadlines(dir, subject.id)).length, 1, "nothing invalid was stored");
});

test("a topic picked from another subject is refused", async () => {
  const { dir, subject } = await scratch();
  const other = await createSubject(dir, { name: "Chemistry" });
  const [bonds] = await addPlannedTopics(dir, other.id, ["Bonds"]);
  await assert.rejects(createDeadline(dir, subject.id, { title: "Quiz", date: "2026-11-02", topicIds: [bonds.id] }), /no longer exist/);
});

test("coveredTopicIds: no topics picked = whole subject; removed topics are ignored, never widened to all", async () => {
  const topics = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(coveredTopicIds({ topicIds: [] }, topics), ["a", "b"]);
  assert.deepEqual(coveredTopicIds({}, topics), ["a", "b"]);
  assert.deepEqual(coveredTopicIds({ topicIds: ["b", "gone"] }, topics), ["b"]);
  assert.deepEqual(coveredTopicIds({ topicIds: ["gone"] }, topics), []);
});

test("removing the content a deadline's topic came from leaves the deadline, now covering nothing", async () => {
  const { dir, subject } = await scratch();
  const [only] = await addPlannedTopics(dir, subject.id, [{ name: "Mitosis", sourceContentIds: ["c1"] }]);
  const d = await createDeadline(dir, subject.id, { title: "Lab", date: "2026-11-02", topicIds: [only.id] });
  await removeContentFromTopics(dir, subject.id, "c1");
  const [stored] = await listDeadlines(dir, subject.id);
  assert.equal(stored.id, d.id);
  assert.deepEqual(coveredTopicIds(stored, []), []);
});

test("nextDeadline is the soonest on or after today, studying for it or not", () => {
  const list = [
    { id: "past", date: "2026-10-19", createdAt: "1" },
    { id: "later", date: "2026-11-30", createdAt: "1" },
    { id: "today", date: "2026-10-20", createdAt: "1", studying: false },
  ];
  assert.equal(nextDeadline(list, "2026-10-20").id, "today");
  assert.equal(nextDeadline(list, "2026-10-21").id, "later");
  assert.equal(nextDeadline(list, "2026-12-01"), null);
});

test("subject summary reports the next deadline", async () => {
  const { dir, subject } = await scratch();
  await createDeadline(dir, subject.id, { title: "Old quiz", date: "2026-10-01" });
  const mid = await createDeadline(dir, subject.id, { title: "Midterm", date: "2026-11-02", studying: false });
  await createDeadline(dir, subject.id, { title: "Final", date: "2026-12-15" });
  const summary = await getSubjectSummary(dir, subject.id, new Date(2026, 9, 20, 12));
  assert.deepEqual(summary.nextDeadline, { id: mid.id, title: "Midterm", date: "2026-11-02", studying: false });
  const after = await getSubjectSummary(dir, subject.id, new Date(2026, 11, 16, 9));
  assert.equal(after.nextDeadline, null);
});
