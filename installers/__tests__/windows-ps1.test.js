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
// instructions" paths are covered. What IS covered instead: Join-PathEnvValues,
// the pure PATH-merge logic behind Update-SessionPath (the $env:Path refresh
// that runs after each winget install so one run of the installer survives
// a fresh git/Node install without needing a new terminal) — reached by
// dot-sourcing the script with ATHENA_TEST_SKIP_MAIN set, see evalInScript
// below.
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
//
// Also NOT exercised here on a non-Windows host: Install-RelaunchShortcuts'
// actual shortcut-file properties, since it calls `New-Object -ComObject
// WScript.Shell` — COM is Windows-only infrastructure, so even a real pwsh
// on this Linux box errors on that line specifically (confirmed manually;
// everything in the function up to that call runs fine). That one test is
// gated on `process.platform === "win32"` in addition to the usual
// PWSH_PATH check, and only actually proves itself on windows-latest CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
 * regardless of what else happens to be on the test runner's real PATH.
 *
 * The symlink is named after the *real target's* extension, not the bare
 * command name: a real windows-latest CI run showed `Test-CommandExists
 * "node"` (a `Get-Command` check) finding a bare-named "node" symlink fine
 * (detection is lenient about extension), but actually invoking it
 * (`& node -v`) silently produced no output at all — no error, no
 * version string — rather than running the real node.exe through the
 * symlink. `Ensure-Git` never surfaced the equivalent problem because it
 * only ever detects git, never invokes it for output, so a bare "git"
 * symlink working for detection was never evidence that invoking it would
 * actually work either. On POSIX, the real binaries have no extension
 * (`path.extname()` is ""), so this is a no-op there — matches today's
 * behavior exactly. */
function makeFakeBin(commands) {
  const dir = mkdtempSync(path.join(tmpdir(), "athena-fakebin-"));
  for (const command of commands) {
    const target = realPathOf(command);
    symlinkSync(target, path.join(dir, command + path.extname(target)));
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

/** Dot-sources windows.ps1 (with ATHENA_TEST_SKIP_MAIN set so Main doesn't
 * run the whole installer) and evaluates `expression` in that same scope,
 * so a function defined in the script - like Join-PathEnvValues - can be
 * called directly without needing a real winget install to exercise it. */
function evalInScript(expression) {
  return execFileSync(
    PWSH_PATH,
    ["-NoLogo", "-NonInteractive", "-Command", `. '${SCRIPT_PATH}'; ${expression}`],
    {
      encoding: "utf8",
      env: mergeEnvCaseInsensitive(process.env, { HOME: tmpdir(), ATHENA_TEST_SKIP_MAIN: "1" }),
    },
  ).trim();
}

// Join-PathEnvValues backs Update-SessionPath (the actual $env:Path refresh
// after each winget install, added so one run of the installer survives a
// fresh git/Node install without needing a new terminal) - winget itself
// isn't invokable from this test (same reasoning as the "deliberately NOT
// exercised" note at the top of this file), so this is the testable unit:
// the pure merge of the registry's Machine/User PATH values Update-SessionPath
// reads after each install.
test(
  "Join-PathEnvValues: combines Machine and User PATH with a separator",
  { skip: !PWSH_PATH && "no PowerShell host found on PATH" },
  () => {
    const result = evalInScript("Join-PathEnvValues 'C:\\Machine\\bin' 'C:\\Users\\me\\bin'");
    assert.equal(result, "C:\\Machine\\bin;C:\\Users\\me\\bin");
  },
);

test(
  "Join-PathEnvValues: a missing scope is dropped, not left as a stray separator",
  { skip: !PWSH_PATH && "no PowerShell host found on PATH" },
  () => {
    assert.equal(evalInScript("Join-PathEnvValues 'C:\\Machine\\bin' $null"), "C:\\Machine\\bin");
    assert.equal(evalInScript("Join-PathEnvValues $null 'C:\\Users\\me\\bin'"), "C:\\Users\\me\\bin");
  },
);

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
  // Main now also runs Install-RelaunchShortcuts after a successful
  // clone/update, which would otherwise write real shortcuts into this
  // test-runner's actual Desktop/Start Menu — point it at scratch dirs
  // instead, same reasoning as every other ATHENA_* override here.
  const desktopDir = mkdtempSync(path.join(tmpdir(), "athena-desktop-"));
  const startMenuDir = mkdtempSync(path.join(tmpdir(), "athena-startmenu-"));
  try {
    const result = runInstaller({
      PATH: fakeBin,
      ATHENA_REPO_URL: fixtureRepo,
      ATHENA_INSTALL_DIR: installDir,
      ATHENA_TEST_MARKER: marker,
      ATHENA_DESKTOP_DIR: desktopDir,
      ATHENA_STARTMENU_DIR: startMenuDir,
    });
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(existsSync(path.join(installDir, ".git")), "should have cloned a real checkout");
    assert.ok(existsSync(marker), "bootstrap.mjs stub should have run");
  } finally {
    cleanup(fakeBin, fixtureRepo, path.dirname(installDir), desktopDir, startMenuDir);
    rmSync(marker, { force: true });
  }
});

test("updates an existing checkout via fast-forward merge instead of re-cloning", { skip: !PWSH_PATH && "no PowerShell host found on PATH" }, () => {
  const fakeBin = makeFakeBin(["git", "node"]);
  const fixtureRepo = makeFixtureRepo();
  const installDir = path.join(mkdtempSync(path.join(tmpdir(), "athena-install-")), "checkout");
  const marker = path.join(tmpdir(), `athena-marker-${process.pid}-${Date.now()}`);
  // See the previous test's comment: keep Install-RelaunchShortcuts off the
  // real Desktop/Start Menu.
  const desktopDir = mkdtempSync(path.join(tmpdir(), "athena-desktop-"));
  const startMenuDir = mkdtempSync(path.join(tmpdir(), "athena-startmenu-"));
  try {
    const first = runInstaller({
      PATH: fakeBin,
      ATHENA_REPO_URL: fixtureRepo,
      ATHENA_INSTALL_DIR: installDir,
      ATHENA_TEST_MARKER: marker,
      ATHENA_DESKTOP_DIR: desktopDir,
      ATHENA_STARTMENU_DIR: startMenuDir,
    });
    assert.equal(first.code, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
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
      ATHENA_DESKTOP_DIR: desktopDir,
      ATHENA_STARTMENU_DIR: startMenuDir,
    });
    assert.equal(second.code, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    assert.match(second.stdout, /updating/i);
    assert.ok(existsSync(path.join(installDir, "NOTE.txt")), "fast-forward merge should have pulled the new commit");
    assert.notEqual(readFileSync(marker, "utf8"), firstMarkerValue, "bootstrap stub should have re-run");
  } finally {
    cleanup(fakeBin, fixtureRepo, path.dirname(installDir), desktopDir, startMenuDir);
    rmSync(marker, { force: true });
  }
});

/** Starts a minimal HTTP server that always answers `{ok: true}` as a
 * SEPARATE OS process, not an in-process `http.createServer` — this test
 * file calls `execFileSync` (synchronous, blocks Node's own event loop for
 * the duration) to run PowerShell, so an in-process listener would never
 * get to accept the PowerShell-side request while that call is blocking. */
function startFakeHealthServer() {
  const script = `
    const http = require("http");
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1", () => console.log("PORT:" + server.address().port));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = out.match(/PORT:(\d+)/);
      if (match) resolve({ child, port: Number(match[1]) });
    });
  });
}

// Backs the "reopen Athena" Start Menu/Desktop shortcut's harmlessness
// guarantee: before doing anything else (git/node checks, a fetch, an npm
// install), Main checks whether Athena is already answering its health
// endpoint and, if so, just opens the browser. Test-AthenaHealthy is the
// one-shot check behind that — verified directly here against a real
// listener and against nothing listening at all, each confirmed manually
// against a real HTTP round trip before writing this test (see this
// session's progress.md entry).
test(
  "Test-AthenaHealthy: true when the health endpoint reports ok, false when nothing is listening",
  { skip: !PWSH_PATH && "no PowerShell host found on PATH" },
  async () => {
    const { child, port } = await startFakeHealthServer();
    try {
      const healthy = evalInScript(`Test-AthenaHealthy 'http://127.0.0.1:${port}/api/health'`);
      assert.equal(healthy, "True");
    } finally {
      child.kill();
    }
    // Port 1 on loopback: refused immediately, nothing ever listens there.
    const unhealthy = evalInScript("Test-AthenaHealthy 'http://127.0.0.1:1/api/health'");
    assert.equal(unhealthy, "False");
  },
);

test(
  "already running: Main opens the browser and returns without ever checking for git/node or hitting the Node installer",
  { skip: !PWSH_PATH && "no PowerShell host found on PATH" },
  async () => {
    const { child, port } = await startFakeHealthServer();
    // Deliberately empty PATH: if Main reached Ensure-Git/Ensure-Node it
    // would fail immediately (no git, no node, no winget) — exit 0 here
    // is itself proof the already-running short-circuit fired before any
    // of that.
    const emptyBin = mkdtempSync(path.join(tmpdir(), "athena-emptybin-"));
    try {
      const result = runInstaller({
        PATH: emptyBin,
        ATHENA_PORT: String(port),
        ATHENA_NO_OPEN_BROWSER: "1",
      });
      assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /already running/i);
    } finally {
      child.kill();
      cleanup(emptyBin);
    }
  },
);

// Install-RelaunchShortcuts' actual .lnk output only exists on Windows
// (WScript.Shell is COM, Windows-only) — see the file-header note. Reads
// the properties back via the same CreateShortcut call PowerShell itself
// uses to read an existing .lnk, which is the normal way to introspect one.
test(
  "Install-RelaunchShortcuts: writes a Desktop and Start Menu shortcut that reruns windows.ps1 under -ExecutionPolicy Bypass, hidden",
  { skip: !PWSH_PATH ? "no PowerShell host found on PATH" : process.platform !== "win32" ? "WScript.Shell COM shortcuts only exist on Windows" : false },
  () => {
    const desktopDir = mkdtempSync(path.join(tmpdir(), "athena-desktop-"));
    const startMenuDir = mkdtempSync(path.join(tmpdir(), "athena-startmenu-"));
    const installDir = mkdtempSync(path.join(tmpdir(), "athena-installdir-"));
    try {
      const output = execFileSync(
        PWSH_PATH,
        [
          "-NoLogo",
          "-NonInteractive",
          "-Command",
          `. '${SCRIPT_PATH}'; Install-RelaunchShortcuts | Out-Null; ` +
            `$wsh = New-Object -ComObject WScript.Shell; ` +
            `$d = $wsh.CreateShortcut((Join-Path '${desktopDir}' 'Athena-Studying.lnk')); ` +
            `$s = $wsh.CreateShortcut((Join-Path '${startMenuDir}' 'Athena-Studying.lnk')); ` +
            `[PSCustomObject]@{ DesktopTarget=$d.TargetPath; DesktopArgs=$d.Arguments; DesktopWorkDir=$d.WorkingDirectory; StartMenuTarget=$s.TargetPath; StartMenuArgs=$s.Arguments } | ConvertTo-Json`,
        ],
        {
          encoding: "utf8",
          env: mergeEnvCaseInsensitive(process.env, {
            HOME: tmpdir(),
            ATHENA_TEST_SKIP_MAIN: "1",
            ATHENA_INSTALL_DIR: installDir,
            ATHENA_DESKTOP_DIR: desktopDir,
            ATHENA_STARTMENU_DIR: startMenuDir,
          }),
        },
      );
      const result = JSON.parse(output);
      assert.match(result.DesktopTarget, /powershell\.exe$/i);
      assert.match(result.DesktopArgs, /-ExecutionPolicy Bypass/);
      assert.match(result.DesktopArgs, /-WindowStyle Hidden/);
      assert.match(result.DesktopArgs, /windows\.ps1/);
      assert.equal(path.normalize(result.DesktopWorkDir), path.normalize(installDir));
      assert.match(result.StartMenuTarget, /powershell\.exe$/i);
      assert.match(result.StartMenuArgs, /-ExecutionPolicy Bypass/);
      assert.match(result.StartMenuArgs, /windows\.ps1/);
    } finally {
      cleanup(desktopDir, startMenuDir, installDir);
    }
  },
);
