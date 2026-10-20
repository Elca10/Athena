import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, getSession, promptReflection, endSession } from "../sessions.js";
import { listReflectionsForSubject, submitSessionReflection, skipSessionReflection } from "../reflection.js";
import { makeTempDir } from "../testHelpers/tempDir.js";

async function scratchDir() {
  return makeTempDir("athena-reflection-");
}

test("listReflectionsForSubject starts empty", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await listReflectionsForSubject(dir, "subject-1"), []);
});

test("submitSessionReflection stores the reflection tagged with the session's subjects and finalizes the session", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1", "subject-2"], mode: "live" });
  await promptReflection(dir, session.id);

  const { reflection, session: ended } = await submitSessionReflection(dir, session.id, {
    learned: "  Recursion needs a base case  ",
    surprised: "",
    connects: "Like induction proofs",
    differently: "",
  });

  assert.equal(reflection.sessionId, session.id);
  assert.deepEqual(reflection.subjectIds, ["subject-1", "subject-2"]);
  assert.equal(reflection.learned, "Recursion needs a base case");
  assert.equal(reflection.surprised, "");
  assert.equal(reflection.connects, "Like induction proofs");
  assert.equal(reflection.differently, "");
  assert.equal(typeof reflection.id, "string");
  assert.equal(typeof reflection.createdAt, "string");

  assert.equal(ended.status, "completed");
  assert.equal(ended.reflectionPending, false);
  assert.equal(typeof ended.endedAt, "string");

  assert.deepEqual(await listReflectionsForSubject(dir, "subject-1"), [reflection]);
  assert.deepEqual(await listReflectionsForSubject(dir, "subject-2"), [reflection]);
  assert.deepEqual(await listReflectionsForSubject(dir, "subject-3"), []);
});

test("submitSessionReflection accepts just one non-blank field", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await promptReflection(dir, session.id);
  const { reflection } = await submitSessionReflection(dir, session.id, { learned: "X" });
  assert.equal(reflection.learned, "X");
  assert.equal(reflection.surprised, "");
});

test("submitSessionReflection rejects an all-blank submission", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await promptReflection(dir, session.id);
  await assert.rejects(
    () => submitSessionReflection(dir, session.id, { learned: "   ", surprised: "" }),
    /at least one reflection answer is required/i,
  );
  assert.deepEqual(await listReflectionsForSubject(dir, "subject-1"), []);
  const stillWaiting = await getSession(dir, session.id);
  assert.equal(stillWaiting.status, "waiting");
  assert.equal(stillWaiting.reflectionPending, true);
});

test("submitSessionReflection rejects a session not awaiting a reflection", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await assert.rejects(
    () => submitSessionReflection(dir, session.id, { learned: "X" }),
    /not awaiting a reflection/,
  );
});

test("submitSessionReflection rejects an already-completed session", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await promptReflection(dir, session.id);
  await endSession(dir, session.id);
  await assert.rejects(
    () => submitSessionReflection(dir, session.id, { learned: "X" }),
    /not awaiting a reflection/,
  );
});

test("submitSessionReflection rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => submitSessionReflection(dir, "no-such-id", { learned: "X" }), /Session not found/);
});

test("submitSessionReflection caps each field's length", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await promptReflection(dir, session.id);
  const { reflection } = await submitSessionReflection(dir, session.id, { learned: "x".repeat(3000) });
  assert.equal(reflection.learned.length, 2000);
});

test("skipSessionReflection finalizes the session without storing a reflection", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await promptReflection(dir, session.id);
  const ended = await skipSessionReflection(dir, session.id);
  assert.equal(ended.status, "completed");
  assert.equal(ended.reflectionPending, false);
  assert.deepEqual(await listReflectionsForSubject(dir, "subject-1"), []);
});

test("skipSessionReflection rejects a session not awaiting a reflection", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
  await assert.rejects(() => skipSessionReflection(dir, session.id), /not awaiting a reflection/);
});

test("skipSessionReflection rejects an unknown session id", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => skipSessionReflection(dir, "no-such-id"), /Session not found/);
});
