import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isCommitCiGreen, promoteRelease } from "../promote-release.mjs";

function runGitAt(dir) {
  return (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

test("isCommitCiGreen: true when the latest run completed successfully", async () => {
  const green = await isCommitCiGreen("abc123", {
    fetchJsonFn: async () => ({
      workflow_runs: [{ status: "completed", conclusion: "success", created_at: "2026-10-12T00:00:00Z" }],
    }),
  });
  assert.equal(green, true);
});

test("isCommitCiGreen: false when there are no runs at all for this commit", async () => {
  const green = await isCommitCiGreen("abc123", { fetchJsonFn: async () => ({ workflow_runs: [] }) });
  assert.equal(green, false);
});

test("isCommitCiGreen: false when the latest run is still in progress", async () => {
  const green = await isCommitCiGreen("abc123", {
    fetchJsonFn: async () => ({
      workflow_runs: [{ status: "in_progress", conclusion: null, created_at: "2026-10-12T00:00:00Z" }],
    }),
  });
  assert.equal(green, false);
});

test("isCommitCiGreen: false when the latest run completed but failed", async () => {
  const green = await isCommitCiGreen("abc123", {
    fetchJsonFn: async () => ({
      workflow_runs: [{ status: "completed", conclusion: "failure", created_at: "2026-10-12T00:00:00Z" }],
    }),
  });
  assert.equal(green, false);
});

test("isCommitCiGreen: picks the MOST RECENT run, not just any run that happens to be green", async () => {
  // An older failed attempt followed by a successful re-run -> green.
  const greenAfterRerun = await isCommitCiGreen("abc123", {
    fetchJsonFn: async () => ({
      workflow_runs: [
        { status: "completed", conclusion: "failure", created_at: "2026-10-12T00:00:00Z" },
        { status: "completed", conclusion: "success", created_at: "2026-10-12T01:00:00Z" },
      ],
    }),
  });
  assert.equal(greenAfterRerun, true);

  // An older success followed by a newer failed re-run -> NOT green, even
  // though a success exists somewhere in the list.
  const notGreenAfterRegress = await isCommitCiGreen("abc123", {
    fetchJsonFn: async () => ({
      workflow_runs: [
        { status: "completed", conclusion: "success", created_at: "2026-10-12T00:00:00Z" },
        { status: "completed", conclusion: "failure", created_at: "2026-10-12T01:00:00Z" },
      ],
    }),
  });
  assert.equal(notGreenAfterRegress, false);
});

test("promoteRelease: refuses and never pushes when CI isn't green", async () => {
  const calls = [];
  const runFn = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    return "";
  };
  const result = await promoteRelease("deadbeef", {
    runFn,
    checkCiGreen: async () => false,
    log: () => {},
    error: () => {},
  });
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "ci-not-green");
  assert.ok(!calls.some((args) => args[0] === "push"), "must never push when CI isn't green");
});

test("promoteRelease: pushes the resolved commit to release, with no --force, when CI is green", async () => {
  const calls = [];
  const runFn = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    return "";
  };
  const result = await promoteRelease("deadbeef", {
    runFn,
    checkCiGreen: async () => true,
    log: () => {},
    error: () => {},
  });
  assert.equal(result.promoted, true);
  assert.equal(result.commit, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  const pushCall = calls.find((args) => args[0] === "push");
  assert.ok(pushCall, "should have pushed");
  assert.deepEqual(pushCall, ["push", "origin", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef:release"]);
  assert.ok(!pushCall.includes("--force") && !pushCall.includes("-f"), "must never force-push");
});

test("promoteRelease: reports unknown-commit (and never pushes) when rev-parse can't resolve it", async () => {
  const calls = [];
  const runFn = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") throw new Error("unknown revision");
    return "";
  };
  const result = await promoteRelease("not-a-real-commit", {
    runFn,
    checkCiGreen: async () => true,
    log: () => {},
    error: () => {},
  });
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "unknown-commit");
  assert.ok(!calls.some((args) => args[0] === "push"), "must never push for an unresolvable commit");
});

test("promoteRelease: reports not-fast-forward (and does not retry with force) when the real push is rejected", async () => {
  const calls = [];
  const runFn = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    if (args[0] === "push") throw new Error("! [rejected] (non-fast-forward)");
    return "";
  };
  const result = await promoteRelease("deadbeef", {
    runFn,
    checkCiGreen: async () => true,
    log: () => {},
    error: () => {},
  });
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "not-fast-forward");
  const pushCalls = calls.filter((args) => args[0] === "push");
  assert.equal(pushCalls.length, 1, "must not retry the push at all, e.g. with --force");
});

// Real-git integration test: no DI for the fast-forward enforcement itself —
// proves that a plain `git push` (no --force) genuinely refuses a
// non-fast-forward update, which is the actual safety net promoteRelease
// relies on rather than re-implementing that check itself.
test("real git: a non-fast-forward push to release is rejected by git itself, with no --force anywhere", async () => {
  const bareDir = mkdtempSync(path.join(tmpdir(), "athena-promote-bare-"));
  const cloneDir = mkdtempSync(path.join(tmpdir(), "athena-promote-clone-"));
  const seedDir = mkdtempSync(path.join(tmpdir(), "athena-promote-seed-"));
  try {
    execFileSync("git", ["init", "-q", "--bare", bareDir]);

    execFileSync("git", ["init", "-q"], { cwd: seedDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: seedDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: seedDir });
    writeFileSync(path.join(seedDir, "VERSION"), "1\n");
    execFileSync("git", ["add", "-A"], { cwd: seedDir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: seedDir });
    execFileSync("git", ["branch", "-M", "main"], { cwd: seedDir });
    execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: seedDir });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seedDir });
    // release starts one commit AHEAD of what we're about to try to push —
    // simulates release already having moved past the commit under test.
    execFileSync("git", ["push", "-q", "origin", "main:release"], { cwd: seedDir });
    writeFileSync(path.join(seedDir, "VERSION"), "2\n");
    execFileSync("git", ["add", "-A"], { cwd: seedDir });
    execFileSync("git", ["commit", "-q", "-m", "release-only commit"], { cwd: seedDir });
    execFileSync("git", ["push", "-q", "origin", "main:release"], { cwd: seedDir });

    // A sibling commit on main that is NOT a descendant of release's tip.
    execFileSync("git", ["checkout", "-q", "-b", "sibling", "HEAD~1"], { cwd: seedDir });
    writeFileSync(path.join(seedDir, "VERSION"), "1-sibling\n");
    execFileSync("git", ["add", "-A"], { cwd: seedDir });
    execFileSync("git", ["commit", "-q", "-m", "sibling commit"], { cwd: seedDir });
    const siblingCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seedDir, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "-q", "origin", "sibling"], { cwd: seedDir });

    execFileSync("git", ["clone", "-q", bareDir, cloneDir]);
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: cloneDir });

    const result = await promoteRelease(siblingCommit, {
      runFn: runGitAt(cloneDir),
      checkCiGreen: async () => true,
      log: () => {},
      error: () => {},
    });
    assert.equal(result.promoted, false);
    assert.equal(result.reason, "not-fast-forward");
    // Confirm release on the remote genuinely wasn't moved.
    const releaseTip = execFileSync("git", ["ls-remote", bareDir, "refs/heads/release"], { encoding: "utf8" }).trim();
    assert.ok(!releaseTip.includes(siblingCommit), "release must not have been moved by the rejected push");
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});
