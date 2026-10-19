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

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync, statSync, chmodSync, readdirSync } from "node:fs";
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
 * file is the stub above instead of the real installer. Its default
 * branch is `release` (matching macos.sh's own ATHENA_UPDATE_BRANCH
 * default) so the plain clone/update tests exercise the real tracked
 * branch without needing an override. */
function makeFixtureRepo({ withMacosSh = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "athena-fixture-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  mkdirSync(path.join(dir, "installers"), { recursive: true });
  writeFileSync(path.join(dir, "installers", "bootstrap.mjs"), stubBootstrapSource);
  // The relaunch app re-runs the checkout's own copy of macos.sh, so the
  // app tests need the real one in the checkout too.
  if (withMacosSh) writeFileSync(path.join(dir, "installers", "macos.sh"), readFileSync(SCRIPT_PATH));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "fixture init"], { cwd: dir });
  execFileSync("git", ["branch", "-M", "release"], { cwd: dir });
  return dir;
}

/** Every run gets its own Applications dir unless a test picks one, so
 * nothing ever writes a relaunch app into a real ~/Applications. */
const scratchAppsRoot = mkdtempSync(path.join(tmpdir(), "athena-apps-"));
after(() => rmSync(scratchAppsRoot, { recursive: true, force: true }));

function installerEnv(env) {
  return {
    HOME: env.HOME ?? tmpdir(),
    ATHENA_APPLICATIONS_DIR: env.ATHENA_APPLICATIONS_DIR ?? mkdtempSync(path.join(scratchAppsRoot, "run-")),
    ...env,
  };
}

function runInstaller(env) {
  try {
    const stdout = execFileSync(BASH_PATH, [SCRIPT_PATH], {
      encoding: "utf8",
      env: installerEnv(env),
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

test("an existing checkout left on main switches cleanly to release (ship queue item 3.5)", () => {
  const fakeBin = makeFakeBin(["git", "node"]);
  const fixtureRepo = makeFixtureRepo();
  // `release` and `main` start equal; `main` stays frozen there (as it
  // would have before this change existed) while `release` moves ahead —
  // exactly the shape a real pre-3.5 install left behind.
  execFileSync("git", ["branch", "main", "release"], { cwd: fixtureRepo });
  writeFileSync(path.join(fixtureRepo, "ONLY_ON_RELEASE.txt"), "release-only content\n");
  execFileSync("git", ["add", "-A"], { cwd: fixtureRepo });
  execFileSync("git", ["commit", "-q", "-m", "release-only commit"], { cwd: fixtureRepo });

  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "athena-install-")), "checkout");
  const marker = path.join(tmpdir(), `athena-marker-${process.pid}-${Date.now()}`);
  try {
    // Simulate an old install: cloned from `main` back when that was the
    // tracked branch, before `release` existed as a concept to this checkout.
    execFileSync("git", ["clone", "--quiet", "--branch", "main", fixtureRepo, installDir]);
    assert.ok(!existsSync(path.join(installDir, "ONLY_ON_RELEASE.txt")), "sanity: old checkout starts without release's commit");

    const result = runInstaller({
      PATH: fakeBin,
      ATHENA_REPO_URL: fixtureRepo,
      ATHENA_INSTALL_DIR: installDir,
      ATHENA_TEST_MARKER: marker,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(path.join(installDir, "ONLY_ON_RELEASE.txt")), "should have switched onto release's content");
    assert.equal(
      execFileSync("git", ["-C", installDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
      "release",
      "should be on a real local release branch, not detached",
    );
    assert.ok(existsSync(marker), "bootstrap.mjs stub should have run");
  } finally {
    cleanup(fakeBin, fixtureRepo, path.dirname(installDir));
    rmSync(marker, { force: true });
  }
});

// Async variant: the "already running" tests serve a health endpoint from
// THIS process, which execFileSync would block from ever answering.
async function runInstallerAsync(env) {
  try {
    const { stdout, stderr } = await promisify(execFile)(BASH_PATH, [SCRIPT_PATH], {
      encoding: "utf8",
      env: installerEnv(env),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("re-running while a server is already up leaves the checkout alone and skips bootstrap (issue #4)", async () => {
  const fakeBin = makeFakeBin(["git", "node", "curl", "grep"]);
  const fixtureRepo = makeFixtureRepo();
  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "athena-install-")), "checkout");
  const marker = path.join(tmpdir(), `athena-marker-${process.pid}-${Date.now()}`);
  const health = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, version: "0.1.0", setupComplete: true }));
  });
  const port = await listen(health);
  try {
    execFileSync("git", ["clone", "--quiet", "--branch", "release", fixtureRepo, installDir]);
    const before = execFileSync("git", ["-C", installDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(fixtureRepo, "NOTE.txt"), "an update the running server must not be swapped under\n");
    execFileSync("git", ["add", "-A"], { cwd: fixtureRepo });
    execFileSync("git", ["commit", "-q", "-m", "update"], { cwd: fixtureRepo });

    const result = await runInstallerAsync({
      PATH: fakeBin,
      ATHENA_REPO_URL: fixtureRepo,
      ATHENA_INSTALL_DIR: installDir,
      ATHENA_TEST_MARKER: marker,
      ATHENA_PORT: String(port),
      ATHENA_NO_OPEN_BROWSER: "1",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /already running/i);
    assert.match(result.stdout, /stop it first/i);
    assert.equal(execFileSync("git", ["-C", installDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), before);
    assert.ok(!existsSync(marker), "bootstrap must not run under a live server");
  } finally {
    health.close();
    cleanup(fakeBin, fixtureRepo, path.dirname(installDir));
    rmSync(marker, { force: true });
  }
});

test("with curl available but nothing listening, it installs normally", async () => {
  const fakeBin = makeFakeBin(["git", "node", "curl", "grep"]);
  const fixtureRepo = makeFixtureRepo();
  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "athena-install-")), "checkout");
  const marker = path.join(tmpdir(), `athena-marker-${process.pid}-${Date.now()}`);
  // Grab a free port, then close it so the health check gets a refusal.
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  try {
    const result = await runInstallerAsync({
      PATH: fakeBin,
      ATHENA_REPO_URL: fixtureRepo,
      ATHENA_INSTALL_DIR: installDir,
      ATHENA_TEST_MARKER: marker,
      ATHENA_PORT: String(port),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /already running/i);
    assert.ok(existsSync(marker), "bootstrap.mjs stub should have run");
  } finally {
    cleanup(fakeBin, fixtureRepo, path.dirname(installDir));
    rmSync(marker, { force: true });
  }
});

// --- Relaunch app (SPEC-v2.md section 7) -----------------------------------

// What writing the app bundle and running its launcher need on PATH, on
// top of git/node for the install itself.
const APP_COMMANDS = ["git", "node", "mkdir", "chmod", "mv", "rm", "cmp", "cat"];
const APP_NAME = "Athena-Studying";

function appPaths(applicationsDir) {
  const app = path.join(applicationsDir, `${APP_NAME}.app`);
  return { app, plist: path.join(app, "Contents", "Info.plist"), exe: path.join(app, "Contents", "MacOS", APP_NAME) };
}

/** A fake `osascript` that records its arguments, so the launcher's error
 * dialog can be asserted without a real Mac. */
function addFakeOsascript(binDir, recordPath) {
  const fake = path.join(binDir, "osascript");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${recordPath}'\n`);
  chmodSync(fake, 0o755);
}

/** Runs the app's executable the way Finder would: a bare system PATH and
 * no ATHENA_* overrides, so everything it needs must be baked in. */
function runLauncher(exe, { HOME, marker }) {
  try {
    execFileSync(exe, [], { encoding: "utf8", env: { HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ATHENA_TEST_MARKER: marker } });
    return 0;
  } catch (err) {
    return typeof err.status === "number" ? err.status : 1;
  }
}

function setUpAppInstall() {
  const fakeBin = makeFakeBin(APP_COMMANDS);
  const fixtureRepo = makeFixtureRepo({ withMacosSh: true });
  const root = mkdtempSync(path.join(tmpdir(), "athena-install-"));
  const env = {
    HOME: path.join(root, "home"),
    PATH: fakeBin,
    ATHENA_REPO_URL: fixtureRepo,
    ATHENA_INSTALL_DIR: path.join(root, "checkout"),
    ATHENA_APPLICATIONS_DIR: path.join(root, "home", "Applications"),
    ATHENA_TEST_MARKER: path.join(root, "marker"),
  };
  mkdirSync(env.HOME);
  return { fakeBin, fixtureRepo, root, env, cleanupAll: () => cleanup(fakeBin, fixtureRepo, root) };
}

test("a fresh install writes a relaunch app with the install's PATH baked in", () => {
  const { fakeBin, env, cleanupAll } = setUpAppInstall();
  try {
    const result = runInstaller(env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Added Athena-Studying to/);
    const { plist, exe } = appPaths(env.ATHENA_APPLICATIONS_DIR);
    assert.match(readFileSync(plist, "utf8"), /<key>CFBundleExecutable<\/key><string>Athena-Studying<\/string>/);
    assert.ok(statSync(exe).mode & 0o100, "launcher must be executable");
    const launcher = readFileSync(exe, "utf8");
    assert.ok(launcher.includes(`export PATH=${fakeBin}\n`), "Finder's bare PATH has no node/claude/gh, so the install's PATH must be baked in");
    assert.ok(launcher.includes(`export ATHENA_INSTALL_DIR=${env.ATHENA_INSTALL_DIR}\n`));
  } finally {
    cleanupAll();
  }
});

test("opening the app re-runs the checkout's installer with the baked-in PATH and logs it", () => {
  const { env, cleanupAll } = setUpAppInstall();
  try {
    assert.equal(runInstaller(env).code, 0);
    rmSync(env.ATHENA_TEST_MARKER);

    const code = runLauncher(appPaths(env.ATHENA_APPLICATIONS_DIR).exe, { HOME: env.HOME, marker: env.ATHENA_TEST_MARKER });
    assert.equal(code, 0);
    assert.ok(existsSync(env.ATHENA_TEST_MARKER), "bootstrap.mjs stub should have run via the app");
    const log = readFileSync(path.join(env.HOME, "Library", "Logs", "Athena-Studying", "launcher.log"), "utf8");
    assert.match(log, /Handing off to the Node installer/);
  } finally {
    cleanupAll();
  }
});

test("when the app can't start Athena it shows a dialog instead of failing silently", () => {
  const { fakeBin, env, root, cleanupAll } = setUpAppInstall();
  const record = path.join(root, "osascript-args");
  try {
    addFakeOsascript(fakeBin, record);
    assert.equal(runInstaller(env).code, 0);
    // A bootstrap that fails, standing in for any startup failure.
    writeFileSync(path.join(env.ATHENA_INSTALL_DIR, "installers", "bootstrap.mjs"), "process.exit(3);\n");

    const code = runLauncher(appPaths(env.ATHENA_APPLICATIONS_DIR).exe, { HOME: env.HOME, marker: env.ATHENA_TEST_MARKER });
    assert.notEqual(code, 0);
    const args = readFileSync(record, "utf8");
    assert.match(args, /couldn't start/);
    assert.match(args, /launcher\.log/);
  } finally {
    cleanupAll();
  }
});

test("re-running with nothing changed leaves the app alone (the app is often what's running)", () => {
  const { env, cleanupAll } = setUpAppInstall();
  try {
    assert.equal(runInstaller(env).code, 0);
    const { app } = appPaths(env.ATHENA_APPLICATIONS_DIR);
    const inodeBefore = statSync(app).ino;
    const second = runInstaller(env);
    assert.equal(second.code, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /Added Athena-Studying/);
    assert.equal(statSync(app).ino, inodeBefore, "an unchanged app must not be swapped out");
  } finally {
    cleanupAll();
  }
});

test("an install whose PATH changed rewrites the app", () => {
  const { fakeBin, env, root, cleanupAll } = setUpAppInstall();
  const otherBin = makeFakeBin(APP_COMMANDS);
  try {
    assert.equal(runInstaller(env).code, 0);
    const second = runInstaller({ ...env, PATH: otherBin });
    assert.equal(second.code, 0, second.stderr);
    const launcher = readFileSync(appPaths(env.ATHENA_APPLICATIONS_DIR).exe, "utf8");
    assert.ok(launcher.includes(`export PATH=${otherBin}\n`));
    assert.ok(!launcher.includes(fakeBin));
    assert.deepEqual(readdirSync(env.ATHENA_APPLICATIONS_DIR), [`${APP_NAME}.app`], "no temp dir left behind");
  } finally {
    cleanupAll();
    cleanup(otherBin, root);
  }
});

test("failing to write the app never fails the install", () => {
  const { env, root, cleanupAll } = setUpAppInstall();
  try {
    const blocker = path.join(root, "not-a-dir");
    writeFileSync(blocker, "");
    const result = runInstaller({ ...env, ATHENA_APPLICATIONS_DIR: path.join(blocker, "Applications") });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Couldn't create the Athena-Studying app/);
    assert.ok(existsSync(env.ATHENA_TEST_MARKER), "the install itself should still have finished");
  } finally {
    cleanupAll();
  }
});

test("re-running while already running still adds the app for an older install", async () => {
  const { env, cleanupAll } = setUpAppInstall();
  const health = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(health);
  try {
    execFileSync("git", ["clone", "--quiet", "--branch", "release", env.ATHENA_REPO_URL, env.ATHENA_INSTALL_DIR]);
    const fakeBinWithCurl = makeFakeBin([...APP_COMMANDS, "curl", "grep"]);
    const result = await runInstallerAsync({ ...env, PATH: fakeBinWithCurl, ATHENA_PORT: String(port), ATHENA_NO_OPEN_BROWSER: "1" });
    cleanup(fakeBinWithCurl);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /already running/i);
    assert.ok(existsSync(appPaths(env.ATHENA_APPLICATIONS_DIR).exe));
  } finally {
    health.close();
    cleanupAll();
  }
});
