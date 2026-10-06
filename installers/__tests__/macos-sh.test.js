// Integration test for installers/macos.sh — the shell half of the
// one-command installer (SPEC.md section 2). Exercises the actual script
// via a real `bash`, not a re-implementation of its logic, because the
// whole point of keeping it this thin is that there's nothing left in it
// worth unit-testing in isolation.
//
// What's deliberately NOT exercised here: the Homebrew auto-install
// branches (`brew install git`/`brew install node`) — this dev box has no
// reason to have Homebrew, and actually invoking a package manager from a
// test would be its own hazard. Only the "already present" and
// "missing, no brew either -> fail with instructions" paths are covered.
//
// installers/bootstrap.mjs is swapped for a tiny stub in the fixture repo
// (see stubBootstrapSource below) so this test proves macos.sh's own
// job — prereq checks, clone, update, handoff — without also paying for a
// real `npm install`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, "..", "macos.sh");
const BASH_PATH = execFileSync("which", ["bash"], { encoding: "utf8" }).trim();

function realPathOf(command) {
  return execFileSync("which", [command], { encoding: "utf8" }).trim();
}

/** A PATH directory with symlinks to the real `git`/`node` on this
 * machine (or whichever subset is requested) — so the script's own
 * `command -v` checks see exactly "present" or "absent", deterministically,
 * regardless of what else happens to be on the test runner's real PATH. */
function makeFakeBin(commands) {
  const dir = mkdtempSync(path.join(tmpdir(), "athena-fakebin-"));
  for (const command of commands) {
    symlinkSync(realPathOf(command), path.join(dir, command));
  }
  return dir;
}

const stubBootstrapSource = `
import { writeFileSync } from "node:fs";
const marker = process.env.ATHENA_TEST_MARKER;
if (marker) writeFileSync(marker, String(Date.now()));
console.log("stub bootstrap ran");
`;

/** A local git repo that stands in for the real Athena repo as a clone
 * source — same shape (installers/bootstrap.mjs present), except that
 * file is the stub above instead of the real installer. */
function makeFixtureRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "athena-fixture-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  mkdirSync(path.join(dir, "installers"), { recursive: true });
  writeFileSync(path.join(dir, "installers", "bootstrap.mjs"), stubBootstrapSource);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "fixture init"], { cwd: dir });
  execFileSync("git", ["branch", "-M", "main"], { cwd: dir });
  return dir;
}

function runInstaller(env) {
  try {
    const stdout = execFileSync(BASH_PATH, [SCRIPT_PATH], {
      encoding: "utf8",
      env: { HOME: env.HOME ?? tmpdir(), ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function cleanup(...dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

test("fails with install instructions when git is missing and there's no Homebrew", () => {
  // No PATH entries at all -> `command -v git` (and brew) both miss.
  const emptyBin = mkdtempSync(path.join(tmpdir(), "athena-emptybin-"));
  try {
    const result = runInstaller({ PATH: emptyBin });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /git/i);
    assert.match(result.stderr, /brew|git-scm/i);
  } finally {
    cleanup(emptyBin);
  }
});

test("fails with install instructions when node is missing and there's no Homebrew (git present)", () => {
  const fakeBin = makeFakeBin(["git"]);
  try {
    const result = runInstaller({ PATH: fakeBin });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /[Nn]ode/);
    assert.match(result.stderr, /brew|nodejs\.org/i);
  } finally {
    cleanup(fakeBin);
  }
});

test("clones a fresh checkout and hands off to the Node installer", () => {
  const fakeBin = makeFakeBin(["git", "node"]);
  const fixtureRepo = makeFixtureRepo();
  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "athena-install-")), "checkout");
  const marker = path.join(tmpdir(), `athena-marker-${process.pid}-${Date.now()}`);
  try {
    const result = runInstaller({
      PATH: fakeBin,
      ATHENA_REPO_URL: fixtureRepo,
      ATHENA_INSTALL_DIR: installDir,
      ATHENA_TEST_MARKER: marker,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(path.join(installDir, ".git")), "should have cloned a real checkout");
    assert.ok(existsSync(marker), "bootstrap.mjs stub should have run");
  } finally {
    cleanup(fakeBin, fixtureRepo, path.dirname(installDir));
    rmSync(marker, { force: true });
  }
});

test("updates an existing checkout via fast-forward merge instead of re-cloning", () => {
  const fakeBin = makeFakeBin(["git", "node"]);
  const fixtureRepo = makeFixtureRepo();
  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "athena-install-")), "checkout");
  const marker = path.join(tmpdir(), `athena-marker-${process.pid}-${Date.now()}`);
  try {
    const first = runInstaller({
      PATH: fakeBin,
      ATHENA_REPO_URL: fixtureRepo,
      ATHENA_INSTALL_DIR: installDir,
      ATHENA_TEST_MARKER: marker,
    });
    assert.equal(first.code, 0, first.stderr);
    const firstMarkerValue = readFileSync(marker, "utf8");

    // A new commit upstream, so the second run has something to pull.
    writeFileSync(path.join(fixtureRepo, "NOTE.txt"), "second commit\n");
    execFileSync("git", ["add", "-A"], { cwd: fixtureRepo });
    execFileSync("git", ["commit", "-q", "-m", "second commit"], { cwd: fixtureRepo });

    const second = runInstaller({
      PATH: fakeBin,
      ATHENA_REPO_URL: fixtureRepo,
      ATHENA_INSTALL_DIR: installDir,
      ATHENA_TEST_MARKER: marker,
    });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /updating/i);
    assert.ok(existsSync(path.join(installDir, "NOTE.txt")), "fast-forward merge should have pulled the new commit");
    assert.notEqual(readFileSync(marker, "utf8"), firstMarkerValue, "bootstrap stub should have re-run");
  } finally {
    cleanup(fakeBin, fixtureRepo, path.dirname(installDir));
    rmSync(marker, { force: true });
  }
});
