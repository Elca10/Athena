// Unit tests for installers/updater.mjs. The git half runs against real
// git (scratch bare origin + installed clone); the install/start half is
// injected here and exercised for real in updater-e2e.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { moveToLatest, runUpdate, waitForExit, isProcessAlive } from "../updater.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configure(dir) {
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
}

function commitFile(dir, name, content = `${name}\n`) {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

function makeRepos() {
  const root = mkdtempSync(path.join(os.tmpdir(), "athena-updater-"));
  const seed = path.join(root, "seed");
  const origin = path.join(root, "origin.git");
  const installed = path.join(root, "installed");
  const maintainer = path.join(root, "maintainer");
  execFileSync("git", ["init", "-q", seed]);
  configure(seed);
  commitFile(seed, "server/package-lock.json", "{}\n");
  commitFile(seed, "README.md", "readme\n");
  git(seed, "branch", "-M", "release");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  // autocrlf set AT clone time: flipping it after checkout (Windows runners
  // default to true) makes git see every CRLF-checked-out file as modified.
  execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", "--branch", "release", origin, installed]);
  execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", "--branch", "release", origin, maintainer]);
  configure(installed);
  configure(maintainer);
  const push = (name) => {
    const sha = commitFile(maintainer, name);
    git(maintainer, "push", "-q", "origin", "release");
    return sha;
  };
  return { root, installed, push, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("moveToLatest fast-forwards onto origin's branch", async () => {
  const { installed, push, cleanup } = makeRepos();
  try {
    const latest = push("two");
    assert.equal(await moveToLatest({ cwd: installed, branch: "release" }), latest);
    assert.equal(git(installed, "rev-parse", "HEAD"), latest);
    assert.equal(git(installed, "rev-parse", "--abbrev-ref", "HEAD"), "release");
  } finally {
    cleanup();
  }
});

test("moveToLatest re-attaches a rolled-back (detached) checkout to the branch", async () => {
  const { installed, push, cleanup } = makeRepos();
  try {
    const first = git(installed, "rev-parse", "HEAD");
    git(installed, "checkout", "-q", "--detach", first);
    const latest = push("two");
    assert.equal(await moveToLatest({ cwd: installed, branch: "release" }), latest);
    assert.equal(git(installed, "rev-parse", "--abbrev-ref", "HEAD"), "release");
  } finally {
    cleanup();
  }
});

test("moveToLatest restores a lockfile npm rewrote, then updates", async () => {
  const { installed, push, cleanup } = makeRepos();
  try {
    writeFileSync(path.join(installed, "server", "package-lock.json"), '{"rewritten": true}\n');
    const latest = push("two");
    assert.equal(await moveToLatest({ cwd: installed, branch: "release" }), latest);
    assert.equal(readFileSync(path.join(installed, "server", "package-lock.json"), "utf8"), "{}\n");
  } finally {
    cleanup();
  }
});

test("moveToLatest refuses, changing nothing, when the checkout has its own commits", async () => {
  const { installed, push, cleanup } = makeRepos();
  try {
    const local = commitFile(installed, "local-only");
    push("two");
    await assert.rejects(moveToLatest({ cwd: installed, branch: "release" }), /commits that aren't on release/);
    assert.equal(git(installed, "rev-parse", "HEAD"), local);
  } finally {
    cleanup();
  }
});

test("moveToLatest refuses, keeping the edit, when a tracked non-lockfile was changed", async () => {
  const { installed, push, cleanup } = makeRepos();
  try {
    const before = git(installed, "rev-parse", "HEAD");
    writeFileSync(path.join(installed, "README.md"), "my own edit\n");
    push("two");
    await assert.rejects(moveToLatest({ cwd: installed, branch: "release" }), /local changes \(README\.md\)/);
    assert.equal(git(installed, "rev-parse", "HEAD"), before);
    assert.equal(readFileSync(path.join(installed, "README.md"), "utf8"), "my own edit\n");
  } finally {
    cleanup();
  }
});

test("waitForExit: returns once the pid is gone, throws if it never goes", async () => {
  let alive = 3;
  await waitForExit(123, { pollMs: 1, isAlive: () => alive-- > 0 });
  await assert.rejects(waitForExit(123, { timeoutMs: 20, pollMs: 1, isAlive: () => true }), /didn't stop/);
  assert.equal(isProcessAlive(process.pid), true);
});

/** runUpdate with git real and everything else injected. */
async function update(installed, overrides = {}) {
  const results = [];
  const recorded = [];
  const outcome = await runUpdate({
    cwd: installed,
    pid: 999999,
    branch: "release",
    port: 1,
    appDataDir: "/unused",
    waitExit: async () => {},
    recordGood: async (sha) => recorded.push(sha),
    writeResult: async (value) => results.push(value),
    start: async () => ({ rolledBackTo: null }),
    ...overrides,
  });
  return { outcome, results, recorded };
}

test("runUpdate: success moves to the new commit, records the old one as the fallback, starts, reports 'updated'", async () => {
  const { installed, push, cleanup } = makeRepos();
  try {
    const from = git(installed, "rev-parse", "HEAD");
    const to = push("two");
    let startedOn = null;
    const { outcome, results, recorded } = await update(installed, {
      start: async () => {
        startedOn = git(installed, "rev-parse", "HEAD");
        return { rolledBackTo: null };
      },
    });
    assert.equal(outcome.result, "updated");
    assert.equal(outcome.from, from);
    assert.equal(outcome.to, to);
    assert.equal(startedOn, to);
    assert.deepEqual(recorded, [from]);
    assert.equal(results.length, 1);
  } finally {
    cleanup();
  }
});

test("runUpdate: the start step rolling back is reported as 'rolled-back'", async () => {
  const { installed, push, cleanup } = makeRepos();
  try {
    const from = git(installed, "rev-parse", "HEAD");
    push("two");
    const { outcome } = await update(installed, { start: async () => ({ rolledBackTo: from }) });
    assert.equal(outcome.result, "rolled-back");
    assert.equal(outcome.runningCommit, from);
  } finally {
    cleanup();
  }
});

test("runUpdate: if the checkout can't move, it restarts the version it had and reports 'failed'", async () => {
  const { installed, push, cleanup } = makeRepos();
  try {
    const from = git(installed, "rev-parse", "HEAD");
    writeFileSync(path.join(installed, "README.md"), "my own edit\n");
    push("two");
    let started = 0;
    const { outcome } = await update(installed, { start: async () => (started++, { rolledBackTo: null }) });
    assert.equal(outcome.result, "failed");
    assert.match(outcome.error, /local changes/);
    assert.equal(started, 1, "the old version must be started again");
    assert.equal(git(installed, "rev-parse", "HEAD"), from);
  } finally {
    cleanup();
  }
});

test("runUpdate: if the old server never exits, nothing is touched", async () => {
  const { installed, push, cleanup } = makeRepos();
  try {
    const from = git(installed, "rev-parse", "HEAD");
    push("two");
    let started = 0;
    const { outcome, recorded } = await update(installed, {
      waitExit: async () => {
        throw new Error("The running copy of Athena (pid 1) didn't stop.");
      },
      start: async () => (started++, { rolledBackTo: null }),
    });
    assert.equal(outcome.result, "failed");
    assert.equal(started, 0);
    assert.deepEqual(recorded, []);
    assert.equal(git(installed, "rev-parse", "HEAD"), from);
  } finally {
    cleanup();
  }
});

test("runUpdate: if even starting fails, the result says nothing is running", async () => {
  const { installed, push, cleanup } = makeRepos();
  try {
    push("two");
    const { outcome } = await update(installed, {
      start: async () => {
        throw new Error("rollback also failed");
      },
    });
    assert.equal(outcome.result, "failed");
    assert.equal(outcome.notRunning, true);
  } finally {
    cleanup();
  }
});
