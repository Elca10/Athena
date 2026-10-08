import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getCurrentCommit,
  readUpdateState,
  recordGoodCommit,
  rollbackToLastGoodCommit,
} from "../rollback.mjs";

function tmpAppDataDir() {
  return mkdtempSync(path.join(tmpdir(), "athena-appdata-"));
}

test("getCurrentCommit returns the trimmed stdout of the injected runFn", async () => {
  const calls = [];
  const runFn = async (args, opts) => {
    calls.push({ args, opts });
    return "abc123";
  };
  const sha = await getCurrentCommit("/some/repo", { runFn });
  assert.equal(sha, "abc123");
  assert.deepEqual(calls[0].args, ["rev-parse", "HEAD"]);
  assert.equal(calls[0].opts.cwd, "/some/repo");
});

test("getCurrentCommit rejects when the runFn rejects (e.g. not a git repo)", async () => {
  const runFn = async () => {
    throw new Error("not a git repository");
  };
  await assert.rejects(getCurrentCommit("/not/a/repo", { runFn }), /not a git repository/);
});

test("readUpdateState returns null when nothing has ever been recorded", async () => {
  const appDataDir = tmpAppDataDir();
  try {
    assert.equal(await readUpdateState(appDataDir), null);
  } finally {
    rmSync(appDataDir, { recursive: true, force: true });
  }
});

test("recordGoodCommit writes state that readUpdateState reads back, creating the updater dir", async () => {
  const appDataDir = tmpAppDataDir();
  try {
    assert.ok(!existsSync(path.join(appDataDir, "updater")));
    await recordGoodCommit("deadbeef", appDataDir);
    assert.ok(existsSync(path.join(appDataDir, "updater", "state.json")));
    const state = await readUpdateState(appDataDir);
    assert.equal(state.lastGoodCommit, "deadbeef");
    assert.ok(state.recordedAt);
  } finally {
    rmSync(appDataDir, { recursive: true, force: true });
  }
});

test("recordGoodCommit overwrites a previously recorded commit", async () => {
  const appDataDir = tmpAppDataDir();
  try {
    await recordGoodCommit("first", appDataDir);
    await recordGoodCommit("second", appDataDir);
    const state = await readUpdateState(appDataDir);
    assert.equal(state.lastGoodCommit, "second");
  } finally {
    rmSync(appDataDir, { recursive: true, force: true });
  }
});

test("rollbackToLastGoodCommit returns null and runs no git command when nothing was ever recorded", async () => {
  const appDataDir = tmpAppDataDir();
  let called = false;
  const runFn = async () => {
    called = true;
    return "";
  };
  try {
    const result = await rollbackToLastGoodCommit({ cwd: "/repo", appDataDir, runFn });
    assert.equal(result, null);
    assert.equal(called, false);
  } finally {
    rmSync(appDataDir, { recursive: true, force: true });
  }
});

test("rollbackToLastGoodCommit checks out the recorded commit and returns its sha", async () => {
  const appDataDir = tmpAppDataDir();
  await recordGoodCommit("goodsha123", appDataDir);
  const calls = [];
  const runFn = async (args, opts) => {
    calls.push({ args, opts });
    return "";
  };
  try {
    const result = await rollbackToLastGoodCommit({ cwd: "/repo", appDataDir, runFn });
    assert.equal(result, "goodsha123");
    assert.deepEqual(calls[0].args, ["checkout", "--detach", "goodsha123"]);
    assert.equal(calls[0].opts.cwd, "/repo");
  } finally {
    rmSync(appDataDir, { recursive: true, force: true });
  }
});

// Real-git integration test: no DI, exercises the actual `git` plumbing
// against a disposable fixture repo, the same belt-and-braces pattern as
// scripts/__tests__ and the rest of installers/__tests__.
test("real git: getCurrentCommit + rollbackToLastGoodCommit round-trip against a real repo", async () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), "athena-rollback-repo-"));
  const appDataDir = tmpAppDataDir();
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    // Windows CI runners default to core.autocrlf=true, which would make
    // `git checkout --detach` below rewrite VERSION's line ending to \r\n
    // and fail the plain-text assertions further down for a reason that
    // has nothing to do with rollback.mjs's own logic.
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repoDir });
    writeFileSync(path.join(repoDir, "VERSION"), "1\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "good version"], { cwd: repoDir });
    const goodCommit = await getCurrentCommit(repoDir);

    await recordGoodCommit(goodCommit, appDataDir);

    writeFileSync(path.join(repoDir, "VERSION"), "2 (broken)\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "broken version"], { cwd: repoDir });
    const brokenCommit = await getCurrentCommit(repoDir);
    assert.notEqual(brokenCommit, goodCommit);
    assert.equal(readFileSync(path.join(repoDir, "VERSION"), "utf8"), "2 (broken)\n");

    const rolledBackTo = await rollbackToLastGoodCommit({ cwd: repoDir, appDataDir });
    assert.equal(rolledBackTo, goodCommit);
    assert.equal(readFileSync(path.join(repoDir, "VERSION"), "utf8"), "1\n");
    assert.equal(await getCurrentCommit(repoDir), goodCommit);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(appDataDir, { recursive: true, force: true });
  }
});
