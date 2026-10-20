import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIRST_VERSION,
  bumpFromTrailers,
  formatReleaseNotes,
  isCommitCiGreen,
  isReleaseNotePath,
  nextVersion,
  parseArgs,
  promoteRelease,
} from "../promote-release.mjs";

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "promote-release.mjs");

// Regression test for the Windows `import.meta.url === \`file://${process.argv[1]}\``
// entry-point bug (CVE-2024-27980's sibling issue found the same day as the
// npm.cmd hotfix): process.argv[1] is a native OS path (backslashes, no
// file:// prefix on Windows), so that bare template comparison can never
// match there — the script's own `if` guard silently never ran `main()` at
// all, with zero output, on real Windows, even though it "happened to
// work" on POSIX (where argv[1] already looks like the file:// form). No
// test here ever ran this file as a real, directly-invoked `node
// scripts/promote-release.mjs` subprocess before — only ever imported its
// named exports — so this exact gap was invisible to every OS in CI,
// including windows-latest. Calling it with no commit arg hits `main`'s
// own fast, side-effect-free usage-error exit before anything resembling a
// real git/network operation, so this is safe to run for real everywhere.
test("entry-point guard: running promote-release.mjs directly for real invokes main()", () => {
  const result = (() => {
    try {
      execFileSync("node", [SCRIPT_PATH], { encoding: "utf8" });
      return { code: 0, stderr: "" };
    } catch (err) {
      return { code: typeof err.status === "number" ? err.status : 1, stderr: err.stderr?.toString() ?? "" };
    }
  })();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage: node scripts\/promote-release\.mjs <commit-sha>/);
});

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

// promote.yml asks while its own run (same head SHA) is still in
// progress, so counting every workflow's runs would block every
// automatic promotion.
test("isCommitCiGreen: only asks about CI's own runs, not every workflow on the commit", async () => {
  let asked;
  await isCommitCiGreen("abc123", {
    fetchJsonFn: async (url) => {
      asked = url;
      return { workflow_runs: [] };
    },
  });
  assert.match(asked, /\/actions\/workflows\/ci\.yml\/runs\?head_sha=abc123/);
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

test("nextVersion: first release is FIRST_VERSION, then bumps from the highest semver tag", () => {
  assert.equal(nextVersion([]), FIRST_VERSION);
  assert.equal(nextVersion(["not-a-version", "v1"], "major"), FIRST_VERSION);
  // Numeric, not lexical: v0.10.0 is higher than v0.9.3.
  const tags = ["v0.9.3", "v0.10.0", "v0.2.7"];
  assert.equal(nextVersion(tags), "v0.10.1");
  assert.equal(nextVersion(tags, "minor"), "v0.11.0");
  assert.equal(nextVersion(tags, "major"), "v1.0.0");
});

test("parseArgs: commit plus optional bump flag, in either order", () => {
  // No flag: null, so promoteRelease reads the bump from the commits.
  assert.deepEqual(parseArgs(["abc123"]), { commit: "abc123", bump: null });
  assert.deepEqual(parseArgs(["--minor", "abc123"]), { commit: "abc123", bump: "minor" });
  assert.deepEqual(parseArgs(["abc123", "--major"]), { commit: "abc123", bump: "major" });
});

test("bumpFromTrailers: highest of minor/major wins, anything else is a patch", () => {
  assert.equal(bumpFromTrailers(""), "patch");
  assert.equal(bumpFromTrailers("\n\nminor\n\n"), "minor");
  assert.equal(bumpFromTrailers("minor\nMajor\npatch"), "major");
  assert.equal(bumpFromTrailers("huge\nyes"), "patch");
});

test("promoteRelease: refuses a commit that's already a version, without pushing or tagging", async () => {
  const calls = [];
  const runFn = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    if (args[0] === "tag" && args[1] === "--points-at") return "v0.3.0";
    return "";
  };
  const result = await promoteRelease("deadbeef", { runFn, checkCiGreen: async () => true, log: () => {}, error: () => {} });
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "already-released");
  assert.equal(result.version, "v0.3.0");
  assert.ok(!calls.some((args) => args[0] === "push" || (args[0] === "tag" && args[1] === "-a")));
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
  assert.deepEqual(pushCall, [
    "push",
    "--atomic",
    "origin",
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef:refs/heads/release",
    `refs/tags/${FIRST_VERSION}`,
  ]);
  assert.equal(result.version, FIRST_VERSION);
  assert.ok(!pushCall.includes("--force") && !pushCall.includes("-f"), "must never force-push");
});

test("promoteRelease: survives the very first promotion ever, when origin has no release ref to fetch yet", async () => {
  const calls = [];
  const runFn = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    if (args[0] === "fetch" && args.includes("release")) throw new Error("fatal: couldn't find remote ref release");
    return "";
  };
  const result = await promoteRelease("deadbeef", {
    runFn,
    checkCiGreen: async () => true,
    log: () => {},
    error: () => {},
  });
  assert.equal(result.promoted, true, "a missing release ref must not abort the promotion");
  assert.ok(calls.some((args) => args[0] === "push"), "should still push to create release");
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
  assert.ok(
    calls.some((args) => args[0] === "tag" && args[1] === "-d"),
    "the local tag must be dropped so a re-run doesn't trip over it",
  );
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
    // --atomic: the rejected branch update must take its tag down with it.
    assert.equal(execFileSync("git", ["ls-remote", "--tags", bareDir], { encoding: "utf8" }).trim(), "");
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

// Real-git integration test for the very first promotion ever, against a
// real remote that genuinely has no `release` ref at all (not injected) —
// caught a real bug live: `git fetch origin main release` fails outright
// ("couldn't find remote ref release") when origin has no release branch
// yet, which aborted the whole promotion on the Athena repo's actual first
// run of this script. Fetching release is best-effort for exactly this
// reason (see promoteRelease's try/catch around it).
test("real git: the very first promotion creates release on a remote that has no release ref yet", async () => {
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
    const mainCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seedDir, encoding: "utf8" }).trim();
    // Deliberately no push to `release` — origin has only `main`, exactly
    // the state of a brand-new repo before this script has ever run.
    assert.equal(
      execFileSync("git", ["ls-remote", bareDir, "refs/heads/release"], { encoding: "utf8" }).trim(),
      "",
      "sanity: release genuinely doesn't exist on origin yet",
    );

    execFileSync("git", ["clone", "-q", bareDir, cloneDir]);
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: cloneDir });

    const result = await promoteRelease(mainCommit, {
      runFn: runGitAt(cloneDir),
      checkCiGreen: async () => true,
      log: () => {},
      error: () => {},
    });
    assert.equal(result.promoted, true);
    const releaseTip = execFileSync("git", ["ls-remote", bareDir, "refs/heads/release"], { encoding: "utf8" }).trim();
    assert.match(releaseTip, new RegExp(`^${mainCommit}`), "release should now exist on origin, pointing at the promoted commit");
    // ...and so should the first version tag, also with no tags on origin
    // beforehand (the other state most likely on a real first run).
    const tagRef = execFileSync("git", ["ls-remote", bareDir, `refs/tags/${FIRST_VERSION}^{}`], { encoding: "utf8" }).trim();
    assert.match(tagRef, new RegExp(`^${mainCommit}`), "first version tag should point at the promoted commit");
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

// Real-git integration test for a normal (non-first) release: the new
// version bumps from the existing tag, and its annotation — which
// release.yml publishes as the GitHub Release notes — lists exactly the
// commits since that tag.
test("real git: a later release bumps from the previous tag and lists the commits since it", async () => {
  const bareDir = mkdtempSync(path.join(tmpdir(), "athena-promote-bare-"));
  const cloneDir = mkdtempSync(path.join(tmpdir(), "athena-promote-clone-"));
  const seedDir = mkdtempSync(path.join(tmpdir(), "athena-promote-seed-"));
  const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "-q", "--bare", bareDir]);
    git(seedDir, ["init", "-q"]);
    git(seedDir, ["config", "user.email", "test@example.com"]);
    git(seedDir, ["config", "user.name", "Test"]);
    git(seedDir, ["commit", "-q", "--allow-empty", "-m", "already shipped"]);
    git(seedDir, ["branch", "-M", "main"]);
    git(seedDir, ["tag", "-a", "v0.4.2", "-m", "earlier release"]);
    git(seedDir, ["remote", "add", "origin", bareDir]);
    git(seedDir, ["push", "-q", "origin", "main", "main:release", "refs/tags/v0.4.2"]);
    git(seedDir, ["commit", "-q", "--allow-empty", "-m", "Refs #9: first fix"]);
    git(seedDir, ["commit", "-q", "--allow-empty", "-m", "Refs #10: second fix"]);
    git(seedDir, ["push", "-q", "origin", "main"]);
    const mainCommit = git(seedDir, ["rev-parse", "HEAD"]);

    execFileSync("git", ["clone", "-q", bareDir, cloneDir]);
    git(cloneDir, ["config", "user.email", "test@example.com"]);
    git(cloneDir, ["config", "user.name", "Test"]);

    const result = await promoteRelease(mainCommit, {
      bump: "minor",
      runFn: runGitAt(cloneDir),
      checkCiGreen: async () => true,
      log: () => {},
      error: () => {},
    });
    assert.equal(result.promoted, true);
    assert.equal(result.version, "v0.5.0");
    assert.match(git(cloneDir, ["ls-remote", bareDir, "refs/tags/v0.5.0^{}"]), new RegExp(`^${mainCommit}`));
    assert.match(git(cloneDir, ["ls-remote", bareDir, "refs/heads/release"]), new RegExp(`^${mainCommit}`));
    const notes = git(cloneDir, ["tag", "-l", "--format=%(contents)", "v0.5.0"]);
    assert.match(notes, /- Refs #10: second fix\n- Refs #9: first fix/);

    // Promoting the same commit again is a no-op, not a second version.
    const again = await promoteRelease(mainCommit, {
      runFn: runGitAt(cloneDir),
      checkCiGreen: async () => true,
      log: () => {},
      error: () => {},
    });
    assert.equal(again.reason, "already-released");
    assert.equal(again.version, "v0.5.0");
  } finally {
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

// A seeded remote at v0.4.2 with main one or more commits ahead, plus a
// fresh clone of it — the state an automatic promotion actually runs in.
function laterReleaseFixture(git, commitMessages) {
  const dirs = ["bare", "clone", "seed"].map((n) => mkdtempSync(path.join(tmpdir(), `athena-promote-${n}-`)));
  const [bareDir, cloneDir, seedDir] = dirs;
  execFileSync("git", ["init", "-q", "--bare", bareDir]);
  git(seedDir, ["init", "-q"]);
  git(seedDir, ["config", "user.email", "test@example.com"]);
  git(seedDir, ["config", "user.name", "Test"]);
  git(seedDir, ["commit", "-q", "--allow-empty", "-m", "already shipped"]);
  git(seedDir, ["branch", "-M", "main"]);
  git(seedDir, ["tag", "-a", "v0.4.2", "-m", "earlier release"]);
  git(seedDir, ["remote", "add", "origin", bareDir]);
  git(seedDir, ["push", "-q", "origin", "main", "main:release", "refs/tags/v0.4.2"]);
  const commits = commitMessages.map((m) => {
    git(seedDir, ["commit", "-q", "--allow-empty", "-m", m]);
    return git(seedDir, ["rev-parse", "HEAD"]);
  });
  git(seedDir, ["push", "-q", "origin", "main"]);
  execFileSync("git", ["clone", "-q", bareDir, cloneDir]);
  git(cloneDir, ["config", "user.email", "test@example.com"]);
  git(cloneDir, ["config", "user.name", "Test"]);
  return { bareDir, cloneDir, commits, cleanup: () => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

const quiet = { checkCiGreen: async () => true, log: () => {}, error: () => {} };

test("real git: with no bump flag, a Release: minor trailer on any shipped commit makes it a minor", async () => {
  const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const fx = laterReleaseFixture(git, [
    "Refs #11: new study mode\n\nRelease: minor",
    "Refs #12: a fix on top",
  ]);
  try {
    const result = await promoteRelease(fx.commits[1], { runFn: runGitAt(fx.cloneDir), ...quiet });
    assert.equal(result.version, "v0.5.0");
    // Notes list subjects only — the trailer doesn't leak into them.
    const notes = git(fx.cloneDir, ["tag", "-l", "--format=%(contents)", "v0.5.0"]);
    assert.match(notes, /- Refs #12: a fix on top\n- Refs #11: new study mode\n/);
    assert.doesNotMatch(notes, /Release: minor/);
  } finally {
    fx.cleanup();
  }
});

test("real git: with no bump flag and no trailer, it's a patch", async () => {
  const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  // "Release: minor" in the middle of a body is prose, not a trailer.
  const fx = laterReleaseFixture(git, ["Refs #13: a fix\n\nRelease: minor is not this.\nJust a fix."]);
  try {
    const result = await promoteRelease(fx.commits[0], { runFn: runGitAt(fx.cloneDir), ...quiet });
    assert.equal(result.version, "v0.4.3");
  } finally {
    fx.cleanup();
  }
});

// Two quick pushes to main: CI for the newer one can finish first and
// promote it, and then the older one's promotion must be a quiet no-op,
// not a failed (rejected) push.
test("real git: promoting a commit that's already behind release is nothing to do, and pushes nothing", async () => {
  const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const fx = laterReleaseFixture(git, ["Refs #14: older", "Refs #15: newer"]);
  try {
    const newer = await promoteRelease(fx.commits[1], { runFn: runGitAt(fx.cloneDir), ...quiet });
    assert.equal(newer.version, "v0.4.3");
    const calls = [];
    const runFn = (args) => {
      calls.push(args);
      return runGitAt(fx.cloneDir)(args);
    };
    const older = await promoteRelease(fx.commits[0], { runFn, ...quiet });
    assert.equal(older.promoted, false);
    assert.equal(older.reason, "already-on-release");
    assert.ok(!calls.some((a) => a[0] === "push" || (a[0] === "tag" && a[1] === "-a")));
    assert.match(git(fx.cloneDir, ["ls-remote", fx.bareDir, "refs/heads/release"]), new RegExp(`^${fx.commits[1]}`));
  } finally {
    fx.cleanup();
  }
});

test("formatReleaseNotes: notes grouped New / Improved / Fixed, then how to update, then every commit", () => {
  const out = formatReleaseNotes({
    notes: {
      fixed: ["Big slide decks upload again. (#6)"],
      new: ["- Rename a subject from its card.", "Study only the files you pick.\nHandy before an exam that isn't cumulative."],
    },
    subjects: ["Refs #6: rename subjects", "README: typo"],
  });
  assert.ok(
    out.startsWith(
      [
        "## New",
        "",
        "- Rename a subject from its card.",
        "- Study only the files you pick.",
        "  Handy before an exam that isn't cumulative.",
        "",
        "## Fixed",
        "",
        "- Big slide decks upload again. (#6)",
        "",
        "**Getting it:**",
      ].join("\n"),
    ),
    out,
  );
  assert.ok(
    out.endsWith(
      "<details>\n<summary>Every change in this release</summary>\n\n- Refs #6: rename subjects\n- README: typo\n\n</details>",
    ),
    out,
  );
  assert.match(out, /\*\*Update now\*\*/);
});

test("formatReleaseNotes: with no notes it says nothing visible changed, and still lists the commits", () => {
  const out = formatReleaseNotes({ notes: {}, subjects: ["CI: faster cache"] });
  assert.match(out, /^Behind-the-scenes changes only/);
  assert.doesNotMatch(out, /^## /m);
  assert.match(out, /- CI: faster cache/);
});

test("isReleaseNotePath: only .md files directly in a known section folder", () => {
  assert.equal(isReleaseNotePath("release-notes/new/rename.md"), true);
  assert.equal(isReleaseNotePath("release-notes/fixed/upload.md"), true);
  assert.equal(isReleaseNotePath("release-notes/README.md"), false);
  assert.equal(isReleaseNotePath("release-notes/features/rename.md"), false);
  assert.equal(isReleaseNotePath("release-notes/new/rename.txt"), false);
});

// A note in a misspelt folder would otherwise be silently left out of
// its release.
test("every file under release-notes/ is the README or a note in a known section", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const walk = (dir) =>
    readdirSync(path.join(root, dir)).flatMap((name) => {
      const rel = `${dir}/${name}`;
      return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
    });
  for (const file of walk("release-notes")) {
    if (file === "release-notes/README.md") continue;
    assert.ok(isReleaseNotePath(file), `${file} isn't in release-notes/new, improved or fixed`);
  }
});

test("real git: notes added since the last version ship once, headings intact, read as of the shipped commit", async () => {
  const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const fx = laterReleaseFixture(git, ["Refs #20: placeholder"]);
  const seedDir = mkdtempSync(path.join(tmpdir(), "athena-promote-notes-"));
  try {
    // Work in a second clone so the fixture's own commits stay as given.
    execFileSync("git", ["clone", "-q", "-b", "main", fx.bareDir, seedDir]);
    git(seedDir, ["config", "user.email", "test@example.com"]);
    git(seedDir, ["config", "user.name", "Test"]);
    const add = (rel, text, msg) => {
      mkdirSync(path.dirname(path.join(seedDir, rel)), { recursive: true });
      writeFileSync(path.join(seedDir, rel), text);
      git(seedDir, ["add", "-A"]);
      git(seedDir, ["commit", "-q", "-m", msg]);
    };
    add("release-notes/new/rename.md", "Rename a subject.\n", "Refs #21: rename");
    add("release-notes/fixed/upload.md", "Uploads work.\n", "Refs #22: upload");
    add("release-notes/fixed/upload.md", "Big uploads work again.\n", "Notes: clearer wording");
    add("release-notes/oops/typo.md", "Never shown.\n", "Notes: misfiled");
    git(seedDir, ["push", "-q", "origin", "main"]);
    const first = git(seedDir, ["rev-parse", "HEAD"]);
    git(fx.cloneDir, ["fetch", "-q", "origin"]);

    assert.equal((await promoteRelease(first, { runFn: runGitAt(fx.cloneDir), ...quiet })).version, "v0.4.3");
    const notes = git(fx.cloneDir, ["tag", "-l", "--format=%(contents)", "v0.4.3"]);
    assert.match(notes, /^## New\n\n- Rename a subject\.\n\n## Fixed\n\n- Big uploads work again\.\n\n/);
    assert.doesNotMatch(notes, /Never shown|Uploads work\./);

    // Editing a shipped note doesn't ship it again.
    add("release-notes/new/rename.md", "Rename a subject from its card.\n", "Notes: reword");
    git(seedDir, ["push", "-q", "origin", "main"]);
    const second = git(seedDir, ["rev-parse", "HEAD"]);
    git(fx.cloneDir, ["fetch", "-q", "origin"]);
    assert.equal((await promoteRelease(second, { runFn: runGitAt(fx.cloneDir), ...quiet })).version, "v0.4.4");
    assert.match(git(fx.cloneDir, ["tag", "-l", "--format=%(contents)", "v0.4.4"]), /^Behind-the-scenes changes only/);
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
    fx.cleanup();
  }
});
