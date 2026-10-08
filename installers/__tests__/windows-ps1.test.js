// Integration test for installers/windows.ps1 — the PowerShell half of the
// one-command installer (SPEC.md section 2), mirroring macos-sh.test.js's
// approach exactly: exercise the actual script via a real PowerShell host,
// not a re-implementation of its logic.
//
// What's deliberately NOT exercised here: the winget auto-install branches
// (`winget install Git.Git`/`winget install OpenJS.NodeJS.LTS`) — winget
// itself doesn't exist on this Linux dev box (or in GitHub Actions'
// ubuntu/macos runners either), so there's no way to invoke it here, same
// reasoning that already excludes macos.sh's Homebrew branches. Only the
// "already present" and "missing, no winget either -> fail with
// instructions" paths are covered.
//
// Runs under whichever PowerShell is on PATH (pwsh preferred, falling back
// to Windows PowerShell's powershell.exe) so this suite works both on a
// real Windows runner and on this Linux box via a manually-installed pwsh
// (see ~/athena-build/progress.md) — ci.yml only wires this step up for
// the Windows leg of the matrix, matching the same OS-gating macos.sh's
// own test already uses.
//
// installers/bootstrap.mjs is swapped for a tiny stub in the fixture repo
// (see stubBootstrapSource below) so this test proves windows.ps1's own
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
const SCRIPT_PATH = path.resolve(__dirname, "..", "windows.ps1");

// `which` on Windows is Git for Windows' MSYS build, which prints
// MSYS/POSIX-style paths (e.g. "/c/Program Files/PowerShell/7/pwsh.exe").
// Handing that straight to execFileSync (no `shell: true`, so it goes
// through Windows' native CreateProcess, not an MSYS runtime that could
// translate it) makes the child process fail to even launch -- caught via
// real windows-latest CI runs where every execFileSync(PWSH_PATH, ...)
// call came back with exit code 1 and completely empty stdout *and*
// stderr, consistent with the process never actually starting rather than
// the script running and failing. `where` is the Windows-native
// equivalent and prints native paths; it can also print more than one
// match (one per PATH directory), so take the first the same way PATH
// search order would.
function resolveCommand(name) {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const output = execFileSync(finder, [name], { encoding: "utf8" }).trim();
    return output.split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

function findPwshPath() {
  for (const candidate of ["pwsh", "powershell.exe", "powershell"]) {
    const resolved = resolveCommand(candidate);
    if (resolved) return resolved;
  }
  return null;
}

const PWSH_PATH = findPwshPath();

function realPathOf(command) {
  return resolveCommand(command);
}

/** A PATH directory with symlinks to the real `git`/`node` on this
 * machine (or whichever subset is requested) — so the script's own
 * `Get-Command` checks see exactly "present" or "absent", deterministically,
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
    const stdout = execFileSync(PWSH_PATH, ["-NoLogo", "-NonInteractive", "-File", SCRIPT_PATH], {
      encoding: "utf8",
      // Start from the real process env, not an almost-empty object: on native
      // Windows, pwsh/powershell.exe/git.exe/node.exe need ambient variables
      // like SystemRoot/windir/TEMP just to start at all (a POSIX shell
      // tolerates a near-empty env fine, which is why this looked harmless on
      // Linux/macOS). Merged case-insensitively so overriding PATH actually
      // replaces Windows' natively-cased `Path` instead of sitting next to it
      // as an unrelated key that the real one wins over.
      env: mergeEnvCaseInsensitive(process.env, { HOME: env.HOME ?? tmpdir(), ...env }),
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

/** Merge `overrides` on top of `base` so that an override replaces a
 * same-named key regardless of case. Needed because `process.env` on
 * Windows exposes variables like `Path`/`ComSpec` under their own native
 * casing, while plain object spread (`{ ...process.env, PATH: fakeBin }`)
 * treats "Path" and "PATH" as two unrelated keys — both end up in the env
 * block handed to the child process, and the real one wins over the
 * override instead of being replaced by it. */
export function mergeEnvCaseInsensitive(base, overrides) {
  const overrideKeysLower = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));
  const result = {};
  for (const [key, value] of Object.entries(base)) {
    if (!overrideKeysLower.has(key.toLowerCase())) result[key] = value;
  }
  return { ...result, ...overrides };
}

// This repo's real git/node run on this (Linux) box, so the Windows
// Path/PATH collision itself can't be reproduced end to end here — these
// tests exercise the merge logic directly against a simulated Windows-shaped
// base env instead, which is what actually proves the fix.
test("mergeEnvCaseInsensitive: override replaces a differently-cased base key", () => {
  const merged = mergeEnvCaseInsensitive({ Path: "C:\\real" }, { PATH: "C:\\fake" });
  assert.deepEqual(merged, { PATH: "C:\\fake" });
});

test("mergeEnvCaseInsensitive: non-conflicting base keys survive untouched", () => {
  const merged = mergeEnvCaseInsensitive({ SystemRoot: "C:\\Windows", Path: "C:\\real" }, { PATH: "C:\\fake" });
  assert.deepEqual(merged, { SystemRoot: "C:\\Windows", PATH: "C:\\fake" });
});

test("mergeEnvCaseInsensitive: same-case override still replaces (POSIX case)", () => {
  const merged = mergeEnvCaseInsensitive({ PATH: "/real" }, { PATH: "/fake" });
  assert.deepEqual(merged, { PATH: "/fake" });
});

test("fails with install instructions when git is missing and there's no winget", { skip: !PWSH_PATH && "no PowerShell host found on PATH" }, () => {
  // No PATH entries at all -> `Get-Command git` (and winget) both miss.
  const emptyBin = mkdtempSync(path.join(tmpdir(), "athena-emptybin-"));
  try {
    const result = runInstaller({ PATH: emptyBin });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /git/i);
    assert.match(result.stderr, /winget|git-scm/i);
  } finally {
    cleanup(emptyBin);
  }
});

test("fails with install instructions when node is missing and there's no winget (git present)", { skip: !PWSH_PATH && "no PowerShell host found on PATH" }, () => {
  const fakeBin = makeFakeBin(["git"]);
  try {
    const result = runInstaller({ PATH: fakeBin });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /[Nn]ode/);
    assert.match(result.stderr, /winget|nodejs\.org/i);
  } finally {
    cleanup(fakeBin);
  }
});

test("clones a fresh checkout and hands off to the Node installer", { skip: !PWSH_PATH && "no PowerShell host found on PATH" }, () => {
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

test("updates an existing checkout via fast-forward merge instead of re-cloning", { skip: !PWSH_PATH && "no PowerShell host found on PATH" }, () => {
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
