// End-to-end test of the actual safety mechanism SPEC.md section 3
// depends on: scripts/install-hooks.js wires git to .githooks/, whose
// pre-commit shells out to scripts/check-privacy.js — this test runs all
// three together against real `git commit`, not just the guard script in
// isolation (check-privacy.test.js covers that).

import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import {
  createFixtureRepo,
  removeFixtureRepo,
  runNodeScript,
  stageFile,
  tryCommit,
  git,
} from "./testFixtureRepo.js";

function withFixture(fn) {
  const dir = createFixtureRepo();
  try {
    return fn(dir);
  } finally {
    removeFixtureRepo(dir);
  }
}

test("install-hooks.js points git at .githooks and makes the hook executable", () => {
  withFixture((dir) => {
    const result = runNodeScript(dir, "scripts/install-hooks.js", []);
    assert.equal(result.code, 0, result.stderr);

    const hooksPath = git(dir, ["config", "--get", "core.hooksPath"]).trim();
    assert.equal(hooksPath, ".githooks");

    if (process.platform !== "win32") {
      const mode = statSync(`${dir}/.githooks/pre-commit`).mode;
      assert.ok(mode & 0o111, "pre-commit hook should be executable");
    }
  });
});

test("without running install-hooks.js, git commit is unaffected (hook not wired up yet)", () => {
  withFixture((dir) => {
    stageFile(dir, "notes.txt", "this would normally be blocked");
    const result = tryCommit(dir, "should succeed, hook not installed");
    assert.equal(result.code, 0);
  });
});

test("after install-hooks.js, git commit is actually blocked by the privacy guard", () => {
  withFixture((dir) => {
    runNodeScript(dir, "scripts/install-hooks.js", []);

    stageFile(dir, "notes.txt", "a disallowed file that should never be committable");
    const blocked = tryCommit(dir, "should be rejected by pre-commit");
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /check-privacy|BLOCKED/i);

    // Confirm it's genuinely blocked, not just noisy: the commit must not
    // exist afterwards.
    const log = git(dir, ["log", "--oneline"]);
    assert.ok(!log.includes("should be rejected"));
  });
});

test("after install-hooks.js, a clean commit still goes through", () => {
  withFixture((dir) => {
    runNodeScript(dir, "scripts/install-hooks.js", []);

    stageFile(dir, "scripts/helper.js", "export const x = 1;\n");
    const ok = tryCommit(dir, "clean commit should succeed");
    assert.equal(ok.code, 0, ok.stderr);

    const log = git(dir, ["log", "--oneline"]);
    assert.match(log, /clean commit should succeed/);
  });
});
