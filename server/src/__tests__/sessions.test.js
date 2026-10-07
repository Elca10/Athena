import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listSessions,
  getSession,
  createSession,
  setSessionStatus,
  setCurrentQuestion,
  recordPendingAnswer,
  recordAnswer,
  endSession,
  archiveSession,
  restoreSession,
} from "../sessions.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-sessions-"));
}

test("listSessions starts empty", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await listSessions(dir), []);
});

test("createSession assigns an id and starts active, unended, unarchived", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  assert.equal(typeof session.id, "string");
  assert.ok(session.id.length > 0);
  assert.deepEqual(session.subjectIds, ["subject-1"]);
  assert.deepEqual(session.topicIds, []);
  assert.equal(session.mode, "live");
  assert.equal(session.status, "active");
  assert.equal(typeof session.startedAt, "string");
  assert.equal(session.endedAt, null);
  assert.equal(session.archived, false);
  assert.equal(session.currentQuestion, null);
  assert.deepEqual(session.history, []);
  assert.deepEqual(await listSessions(dir), [session]);
});

test("createSession accepts multiple subjects and topicIds", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, {
    subjectIds: ["subject-1", "subject-2"],
    mode: "ready",
    topicIds: ["topic-1", "topic-2"],
  });
  assert.deepEqual(session.subjectIds, ["subject-1", "subject-2"]);
  assert.deepEqual(session.topicIds, ["topic-1", "topic-2"]);
});

test("createSession rejects an empty or missing subjectIds", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => createSession(dir, { subjectIds: [], mode: "live" }), /non-empty array/);
  await assert.rejects(() => createSession(dir, { mode: "live" }), /non-empty array/);
});

test("createSession rejects an unknown mode", async () => {
  const dir = await scratchDir();
  await assert.rejects(
    () => createSession(dir, { subjectIds: ["subject-1"], mode: "turbo" }),
    /mode must be one of/,
  );
});

test("getSession returns null for an unknown id", async () => {
  const dir = await scratchDir();
  assert.equal(await getSession(dir, "no-such-id"), null);
});

test("getSession finds a session by id", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  assert.deepEqual(await getSession(dir, session.id), session);
});

test("setSessionStatus moves a session between active and waiting", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  const waiting = await setSessionStatus(dir, session.id, "waiting");
  assert.equal(waiting.status, "waiting");
  const active = await setSessionStatus(dir, session.id, "active");
  assert.equal(active.status, "active");
});

test("setSessionStatus rejects an unknown status", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await assert.rejects(() => setSessionStatus(dir, session.id, "paused"), /status must be one of/);
});

test("setSessionStatus rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => setSessionStatus(dir, "no-such-id", "waiting"), /Session not found/);
});

test("setSessionStatus refuses to reopen a completed session", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await endSession(dir, session.id);
  await assert.rejects(() => setSessionStatus(dir, session.id, "active"), /already completed/);
});

test("setCurrentQuestion stores the question and moves the session to waiting", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  const question = { topicId: "topic-1", subjectId: "subject-1", prompt: "What is X?", type: "free_recall", difficulty: "intro" };
  const updated = await setCurrentQuestion(dir, session.id, question);
  assert.deepEqual(updated.currentQuestion, question);
  assert.equal(updated.status, "waiting");
  assert.deepEqual(await getSession(dir, session.id), updated);
});

test("setCurrentQuestion rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => setCurrentQuestion(dir, "no-such-id", { prompt: "x" }), /Session not found/);
});

test("setCurrentQuestion refuses to reopen a completed session", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await endSession(dir, session.id);
  await assert.rejects(() => setCurrentQuestion(dir, session.id, { prompt: "x" }), /already completed/);
});

test("recordPendingAnswer stashes an answer on currentQuestion and keeps the session waiting", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "ready" });
  const question = { topicId: "topic-1", subjectId: "subject-1", prompt: "Explain X.", type: "short_answer", rubric: ["a"] };
  await setCurrentQuestion(dir, session.id, question);
  const updated = await recordPendingAnswer(dir, session.id, { answerText: "X is a thing", confidence: 3 });
  assert.deepEqual(updated.currentQuestion, { ...question, pendingAnswer: { answerText: "X is a thing", confidence: 3 } });
  assert.equal(updated.status, "waiting");
  assert.deepEqual(updated.history, []);
});

test("recordPendingAnswer rejects a session with no current question", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "ready" });
  await assert.rejects(() => recordPendingAnswer(dir, session.id, { answerText: "x" }), /no current question to answer/);
});

test("recordPendingAnswer rejects a question that already has a pending answer", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "ready" });
  await setCurrentQuestion(dir, session.id, { prompt: "x" });
  await recordPendingAnswer(dir, session.id, { answerText: "first" });
  await assert.rejects(() => recordPendingAnswer(dir, session.id, { answerText: "second" }), /already has a pending answer/);
});

test("recordPendingAnswer rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => recordPendingAnswer(dir, "no-such-id", { answerText: "x" }), /Session not found/);
});

test("recordPendingAnswer refuses to touch a completed session", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "ready" });
  await setCurrentQuestion(dir, session.id, { prompt: "x" });
  await endSession(dir, session.id);
  await assert.rejects(() => recordPendingAnswer(dir, session.id, { answerText: "x" }), /already completed/);
});

test("recordAnswer appends to history, clears currentQuestion, and moves the session back to active", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  const question = { topicId: "topic-1", subjectId: "subject-1", prompt: "What is X?", type: "free_recall", difficulty: "intro" };
  await setCurrentQuestion(dir, session.id, question);
  const entry = { ...question, answerText: "X is a thing", confidence: 3, rating: "good", feedback: "Close enough." };
  const updated = await recordAnswer(dir, session.id, entry);
  assert.deepEqual(updated.history, [entry]);
  assert.equal(updated.currentQuestion, null);
  assert.equal(updated.status, "active");
  assert.deepEqual(await getSession(dir, session.id), updated);
});

test("recordAnswer appends a second entry onto an existing history", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await setCurrentQuestion(dir, session.id, { prompt: "Q1" });
  const first = await recordAnswer(dir, session.id, { prompt: "Q1", answerText: "A1" });
  assert.equal(first.history.length, 1);
  await setCurrentQuestion(dir, session.id, { prompt: "Q2" });
  const second = await recordAnswer(dir, session.id, { prompt: "Q2", answerText: "A2" });
  assert.deepEqual(second.history, [{ prompt: "Q1", answerText: "A1" }, { prompt: "Q2", answerText: "A2" }]);
});

test("recordAnswer rejects a session with no current question", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await assert.rejects(() => recordAnswer(dir, session.id, { prompt: "x" }), /no current question to answer/);
});

test("recordAnswer rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => recordAnswer(dir, "no-such-id", { prompt: "x" }), /Session not found/);
});

test("recordAnswer refuses to record against a completed session", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await setCurrentQuestion(dir, session.id, { prompt: "x" });
  await endSession(dir, session.id);
  await assert.rejects(() => recordAnswer(dir, session.id, { prompt: "x" }), /already completed/);
});

test("endSession marks a session completed and stamps endedAt", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  const ended = await endSession(dir, session.id);
  assert.equal(ended.status, "completed");
  assert.equal(typeof ended.endedAt, "string");
});

test("endSession rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => endSession(dir, "no-such-id"), /Session not found/);
});

test("archiveSession hides a session from the default list but not includeArchived:true", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  const archived = await archiveSession(dir, session.id);
  assert.equal(archived.archived, true);
  assert.deepEqual(await listSessions(dir), []);
  assert.deepEqual(await listSessions(dir, { includeArchived: true }), [archived]);
});

test("restoreSession brings an archived session back into the default list", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await archiveSession(dir, session.id);
  const restored = await restoreSession(dir, session.id);
  assert.equal(restored.archived, false);
  assert.deepEqual(await listSessions(dir), [restored]);
});

test("archiveSession on an unknown id throws without corrupting the store", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await assert.rejects(() => archiveSession(dir, "no-such-id"), /not found/i);
  assert.deepEqual(await listSessions(dir), [session]);
});

test("createSession never collides on id across concurrent creates", async () => {
  const dir = await scratchDir();
  const created = await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      createSession(dir, { subjectIds: [`subject-${i}`], mode: "live" }),
    ),
  );
  const ids = new Set(created.map((s) => s.id));
  assert.equal(ids.size, 15);
  assert.equal((await listSessions(dir)).length, 15);
});
