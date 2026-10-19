import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { checkForUpdate, makeUpdateChecker, updateBranch } from "../updateCheck.js";
import { makeUpdateRouter } from "../routes/update.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configure(dir) {
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
}

function commit(dir, name) {
  writeFileSync(path.join(dir, name), `${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

/** A bare "origin" with a `release` branch, an installed clone of it, and
 * a separate working clone standing in for the maintainer pushing. */
function makeRepos() {
  const root = mkdtempSync(path.join(os.tmpdir(), "athena-update-check-"));
  const seed = path.join(root, "seed");
  const origin = path.join(root, "origin.git");
  const installed = path.join(root, "installed");
  const maintainer = path.join(root, "maintainer");
  execFileSync("git", ["init", "-q", seed]);
  configure(seed);
  commit(seed, "one");
  git(seed, "branch", "-M", "release");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  execFileSync("git", ["clone", "-q", "--branch", "release", origin, installed]);
  execFileSync("git", ["clone", "-q", "--branch", "release", origin, maintainer]);
  configure(installed);
  configure(maintainer);
  return { root, origin, installed, maintainer };
}

test("updateBranch: defaults to release, honours ATHENA_UPDATE_BRANCH", () => {
  assert.equal(updateBranch({}), "release");
  assert.equal(updateBranch({ ATHENA_UPDATE_BRANCH: "main" }), "main");
});

test("checkForUpdate: up to date reports no update", async () => {
  const { root, installed } = makeRepos();
  try {
    const status = await checkForUpdate({ repoDir: installed, branch: "release" });
    assert.equal(status.available, false);
    assert.equal(status.current, git(installed, "rev-parse", "HEAD"));
    assert.equal(status.latest, status.current);
    assert.equal(status.error, undefined);
    assert.ok(!Number.isNaN(Date.parse(status.checkedAt)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkForUpdate: a new commit on origin's release is an available update, and the checkout doesn't move", async () => {
  const { root, installed, maintainer } = makeRepos();
  try {
    const before = git(installed, "rev-parse", "HEAD");
    const pushed = commit(maintainer, "two");
    git(maintainer, "push", "-q", "origin", "release");

    const status = await checkForUpdate({ repoDir: installed, branch: "release" });
    assert.equal(status.available, true);
    assert.equal(status.current, before);
    assert.equal(status.latest, pushed);
    assert.equal(git(installed, "rev-parse", "HEAD"), before, "a check must never move the checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A plain `git fetch origin release` doesn't bring tags along (verified
// against real git), so without --tags an installed copy could never name
// the version it's being offered, or the one it ends up running.
test("checkForUpdate: names a tagged release, and the installed copy gets its tag", async () => {
  const { root, installed, maintainer } = makeRepos();
  try {
    commit(maintainer, "two");
    git(maintainer, "tag", "-a", "v0.2.0", "-m", "- two");
    git(maintainer, "push", "-q", "--atomic", "origin", "release", "refs/tags/v0.2.0");

    const status = await checkForUpdate({ repoDir: installed, branch: "release" });
    assert.equal(status.available, true);
    assert.equal(status.latestVersion, "v0.2.0");
    assert.equal(git(installed, "tag", "--list", "v*"), "v0.2.0");

    // An untagged commit on top just has no version to show.
    commit(maintainer, "three");
    git(maintainer, "push", "-q", "origin", "release");
    const untagged = await checkForUpdate({ repoDir: installed, branch: "release" });
    assert.equal(untagged.available, true);
    assert.equal(untagged.latestVersion, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkForUpdate: a checkout that's ahead of origin (dev clone) is never offered an update", async () => {
  const { root, installed } = makeRepos();
  try {
    commit(installed, "local-only");
    const status = await checkForUpdate({ repoDir: installed, branch: "release" });
    assert.equal(status.available, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkForUpdate: an unreachable origin means 'no update' with the reason kept, not a throw", async () => {
  const { root, installed } = makeRepos();
  try {
    git(installed, "remote", "set-url", "origin", path.join(root, "does-not-exist.git"));
    const status = await checkForUpdate({ repoDir: installed, branch: "release" });
    assert.equal(status.available, false);
    assert.equal(status.current, git(installed, "rev-parse", "HEAD"));
    assert.equal(status.latest, null);
    assert.match(status.error, /fetch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkForUpdate: not a git checkout at all is also just 'no update'", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "athena-update-nogit-"));
  try {
    const status = await checkForUpdate({ repoDir: dir, branch: "release" });
    assert.equal(status.available, false);
    assert.equal(status.current, null);
    assert.ok(status.error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeUpdateChecker: overlapping checks share one in-flight check", async () => {
  let calls = 0;
  let release;
  const result = { available: true, current: "a", latest: "b", checkedAt: "t" };
  const check = () => {
    calls++;
    if (calls > 1) return Promise.resolve(result);
    return new Promise((resolve) => {
      release = () => resolve(result);
    });
  };
  const checker = makeUpdateChecker({ repoDir: "/unused", check });
  assert.equal(checker.getStatus().checkedAt, null);
  const first = checker.checkNow();
  const second = checker.checkNow();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await second);
  assert.equal(checker.getStatus().available, true);
  await checker.checkNow(); // finished, so a later call checks again
  assert.equal(calls, 2);
});

test("GET /api/update/status and POST /api/update/check", async () => {
  const checker = makeUpdateChecker({
    repoDir: "/unused",
    check: async () => ({ available: true, current: "a", latest: "b", checkedAt: "2026-10-13T00:00:00.000Z" }),
  });
  const app = express();
  app.use("/api/update", makeUpdateRouter(checker));
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const before = await (await fetch(`http://127.0.0.1:${port}/api/update/status`)).json();
    assert.deepEqual(before, {
      available: false,
      current: null,
      latest: null,
      checkedAt: null,
      updating: false,
      blockedReason: null,
      lastUpdate: null,
    });
    const checked = await (await fetch(`http://127.0.0.1:${port}/api/update/check`, { method: "POST" })).json();
    assert.equal(checked.available, true);
    const after = await (await fetch(`http://127.0.0.1:${port}/api/update/status`)).json();
    assert.equal(after.latest, "b");
  } finally {
    server.close();
  }
});
