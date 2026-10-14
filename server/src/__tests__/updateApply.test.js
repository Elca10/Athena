import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { makeUpdateApplier, readLastUpdate, DRAINING_MESSAGE } from "../updateApply.js";
import { activeModelCalls, runCommand } from "../processUtil.js";
import { makeJsonFileStore, waitForWritesIdle } from "../store/jsonFileStore.js";
import { createSession, getSession, reconcileInterruptedSessions, setCurrentQuestion } from "../sessions.js";
import { fakeClaudeOnPath } from "./fakeClaudeOnPath.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-update-apply-"));
}

const AVAILABLE = { available: true, current: "aaa", latest: "bbb", checkedAt: "t" };

function fakeChecker(status = AVAILABLE) {
  return { checkNow: async () => status, getStatus: () => status };
}

/** An express app with the applier's middleware in front of a slow POST,
 * a GET /health, and the apply call itself, like index.js wires it. */
async function harness(overrides = {}) {
  const appDataDir = await scratchDir();
  const calls = { launched: 0, exited: 0 };
  const applier = makeUpdateApplier({
    checker: fakeChecker(),
    repoDir: "/unused",
    appDataDir,
    port: 0,
    branch: "release",
    launchUpdater: () => calls.launched++,
    exit: () => calls.exited++,
    modelCalls: () => 0,
    pollMs: 5,
    ...overrides,
  });
  const app = express();
  app.use("/api", applier.middleware);
  let releaseSlow;
  app.post("/api/slow", (_req, res) => {
    releaseSlow = () => res.json({ saved: true });
  });
  app.post("/api/write", (_req, res) => res.json({ ok: true }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/subjects", (_req, res) => res.json([]));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { applier, calls, base, server, appDataDir, release: () => releaseSlow?.() };
}

test("apply refuses with a plain reason while a model call is running", async () => {
  const { applier, server, calls } = await harness({ modelCalls: () => 1 });
  try {
    const result = await applier.apply();
    assert.equal(result.ok, false);
    assert.match(result.reason, /middle of working/);
    assert.match(applier.blockedReason(), /middle of working/);
    assert.equal(applier.isDraining(), false);
    assert.equal(calls.launched, 0);
  } finally {
    server.close();
  }
});

test("apply refuses when already up to date", async () => {
  const { applier, server } = await harness({ checker: fakeChecker({ ...AVAILABLE, available: false }) });
  try {
    const result = await applier.apply();
    assert.equal(result.ok, false);
    assert.match(result.reason, /up to date/);
  } finally {
    server.close();
  }
});

test("draining: in-flight requests finish first, new writes get a 503, health still answers, then hand-off", async () => {
  const { applier, calls, base, server, release } = await harness();
  try {
    const slow = fetch(`${base}/slow`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 50)); // let it arrive

    const result = await applier.apply();
    assert.equal(result.ok, true);
    assert.equal(result.to, "bbb");
    assert.equal(applier.isDraining(), true);

    const rejected = await fetch(`${base}/write`, { method: "POST" });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).error, DRAINING_MESSAGE);
    assert.equal((await fetch(`${base}/subjects`)).status, 503, "non-update GETs are turned away too");
    assert.equal((await fetch(`${base}/health`)).status, 200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.launched, 0, "must not hand off while a request is still in flight");
    release();
    assert.deepEqual(await (await slow).json(), { saved: true }, "the in-flight request completes normally");

    assert.deepEqual(await result.done, { handedOff: true });
    assert.equal(calls.launched, 1);
    assert.equal(calls.exited, 1);
    assert.match((await applier.apply()).reason, /already in progress/);
  } finally {
    server.close();
  }
});

test("a drain that times out cancels the update, records why, and resumes normal service", async () => {
  const { applier, calls, base, server, appDataDir, release } = await harness({ drainTimeoutMs: 100 });
  try {
    const slow = fetch(`${base}/slow`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await applier.apply();
    const outcome = await result.done;
    assert.equal(outcome.handedOff, false);
    assert.equal(calls.launched, 0);
    assert.equal(calls.exited, 0);
    assert.equal(applier.isDraining(), false);
    assert.equal((await fetch(`${base}/write`, { method: "POST" })).status, 200);
    assert.equal((await readLastUpdate(appDataDir)).result, "cancelled");
    release();
    await slow;
  } finally {
    server.close();
  }
});

test("activeModelCalls counts a running `claude -p` turn but not `/usage`", async () => {
  const { env } = await fakeClaudeOnPath();
  const usage = runCommand("claude", ["-p", "--", "/usage"], { env, timeoutMs: 20_000 });
  assert.equal(activeModelCalls(), 0);
  await usage;
  const turn = runCommand("claude", ["-p"], { env, input: "hello", timeoutMs: 20_000 });
  assert.equal(activeModelCalls(), 1);
  await turn;
  assert.equal(activeModelCalls(), 0);
});

test("waitForWritesIdle waits for a store write in progress", async () => {
  const dir = await scratchDir();
  const store = makeJsonFileStore(dir, "x.json", []);
  const big = Array.from({ length: 50_000 }, (_, i) => ({ i, text: "some text to make this write take a moment" }));
  let written = false;
  const write = store.write(big).then(() => (written = true));
  await waitForWritesIdle();
  assert.equal(written, true);
  await write;
  assert.equal((await store.read()).length, big.length);
});

test("reconcileInterruptedSessions moves only active sessions to waiting, keeping their question", async () => {
  const dir = await scratchDir();
  const fresh = await createSession(dir, { subjectIds: ["s1"], mode: "ready" }); // active, no question yet
  const waiting = await createSession(dir, { subjectIds: ["s1"], mode: "live" });
  await setCurrentQuestion(dir, waiting.id, { prompt: "What is a mutex?" });

  assert.equal(await reconcileInterruptedSessions(dir), 1);
  assert.equal((await getSession(dir, fresh.id)).status, "waiting");
  const untouched = await getSession(dir, waiting.id);
  assert.equal(untouched.status, "waiting");
  assert.equal(untouched.currentQuestion.prompt, "What is a mutex?");
  assert.equal(await reconcileInterruptedSessions(dir), 0, "idempotent");
});

test("reconcileInterruptedSessions doesn't rewrite the file when nothing is active", async () => {
  const dir = await scratchDir();
  const session = await createSession(dir, { subjectIds: ["s1"], mode: "live" });
  await setCurrentQuestion(dir, session.id, { prompt: "Q" });
  const file = path.join(dir, "db", "sessions.json");
  const before = await fs.stat(file);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await reconcileInterruptedSessions(dir), 0);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});
