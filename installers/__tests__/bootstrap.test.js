import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveSpawnTarget, run, waitForHealth, openBrowser, updateAndStart } from "../bootstrap.mjs";

const REPO_ROOT_REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("resolveSpawnTarget: node/git pass straight through on every platform, no .cmd/.cli resolution", () => {
  const opts = { platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe", existsFn: () => true };
  assert.deepEqual(resolveSpawnTarget("node", ["x.js"], opts), { command: "node", args: ["x.js"], shell: false });
  assert.deepEqual(resolveSpawnTarget("git", ["status"], opts), { command: "git", args: ["status"], shell: false });
  assert.deepEqual(resolveSpawnTarget("npm", ["install"], { platform: "darwin" }), {
    command: "npm",
    args: ["install"],
    shell: false,
  });
  assert.deepEqual(resolveSpawnTarget("npm", ["install"], { platform: "linux" }), {
    command: "npm",
    args: ["install"],
    shell: false,
  });
});

test("resolveSpawnTarget: npm/npx on win32 run npm-cli.js/npx-cli.js directly via execPath's node.exe, not the .cmd shim", () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const seenPaths = [];
  const existsFn = (p) => {
    seenPaths.push(p);
    return true;
  };

  const expectedCliScript = path.win32.join(
    "C:\\Program Files\\nodejs",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );

  const target = resolveSpawnTarget("npm", ["install"], { platform: "win32", execPath, existsFn });
  assert.equal(target.command, execPath);
  assert.deepEqual(target.args, [expectedCliScript, "install"]);
  assert.equal(target.shell, false);
  assert.deepEqual(seenPaths, [expectedCliScript]);

  const npxTarget = resolveSpawnTarget("npx", ["--version"], { platform: "win32", execPath, existsFn });
  assert.ok(npxTarget.args[0].endsWith(path.win32.join("npm", "bin", "npx-cli.js")));
});

test("resolveSpawnTarget: falls back to the .cmd shim with shell:true when npm-cli.js isn't where a standard install puts it", () => {
  const target = resolveSpawnTarget("npm", ["install"], {
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    existsFn: () => false,
  });
  assert.deepEqual(target, { command: "npm.cmd", args: ["install"], shell: true });
});

// Regression test for CVE-2024-27980: on patched Node (>=18.20.2/20.12.2/
// 21.7.2 — any current LTS), spawning a .cmd/.bat target without
// shell:true throws EINVAL instead of running it. bootstrap.mjs's own
// run("npm", ...) path (installAndStart) was never exercised by any test
// with a *real* npm spawn before this — every existing updateAndStart test
// injects a fake `install`, so the actual spawn call was unverified on
// every OS in CI, including windows-latest, until now. `npm --version`
// touches no network and no disk beyond npm's own startup, so this is safe
// to run unconditionally in CI on all three OSes.
test("run(): actually spawns real npm without throwing EINVAL", async () => {
  await run("npm", ["--version"]);
});

test("waitForHealth resolves as soon as the endpoint reports ok:true", async () => {
  let callCount = 0;
  const fetchFn = async () => {
    callCount += 1;
    if (callCount < 3) throw new Error("ECONNREFUSED (server not up yet)");
    return { ok: true, version: "0.1.0", setupComplete: false };
  };
  const delays = [];
  const delayFn = async (ms) => {
    delays.push(ms);
  };

  const body = await waitForHealth("http://127.0.0.1:0/api/health", { fetchFn, delayFn, intervalMs: 50 });
  assert.equal(body.ok, true);
  assert.equal(callCount, 3);
  assert.deepEqual(delays, [50, 50]);
});

test("waitForHealth against a real ephemeral-port server", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const body = await waitForHealth(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 2000, intervalMs: 20 });
    assert.equal(body.ok, true);
  } finally {
    server.close();
  }
});

test("waitForHealth times out when nothing ever answers", async () => {
  const fetchFn = async () => {
    throw new Error("ECONNREFUSED");
  };
  const delayFn = async () => {};
  await assert.rejects(
    waitForHealth("http://127.0.0.1:1/api/health", { fetchFn, delayFn, timeoutMs: 1 }),
    /Timed out waiting/,
  );
});

test("openBrowser picks the right command per platform and never throws", () => {
  const calls = [];
  function fakeSpawn(command, args) {
    calls.push({ command, args });
    return { unref() {}, on() {} };
  }

  openBrowser("http://127.0.0.1:4417/", { platform: "darwin", spawnFn: fakeSpawn });
  openBrowser("http://127.0.0.1:4417/", { platform: "win32", spawnFn: fakeSpawn });
  openBrowser("http://127.0.0.1:4417/", { platform: "linux", spawnFn: fakeSpawn });

  assert.deepEqual(calls[0], { command: "open", args: ["http://127.0.0.1:4417/"] });
  assert.deepEqual(calls[1], { command: "cmd", args: ["/c", "start", "", "http://127.0.0.1:4417/"] });
  assert.deepEqual(calls[2], { command: "xdg-open", args: ["http://127.0.0.1:4417/"] });
});

test("openBrowser swallows a spawn failure instead of throwing (headless/no-browser case)", () => {
  const spawnFn = () => {
    throw new Error("no display");
  };
  assert.doesNotThrow(() => openBrowser("http://127.0.0.1:4417/", { platform: "linux", spawnFn }));
});

// updateAndStart (SPEC.md section 2, auto-update + rollback) — every
// dependency is injected, so these never touch a real git repo, npm
// install, or server process. rollback.mjs's own real-git plumbing is
// covered separately in rollback.test.js.

test("updateAndStart: records the commit as good after a clean install, does not roll back", async () => {
  const recorded = [];
  const result = await updateAndStart({
    cwd: "/repo",
    getCommit: async () => "commit-a",
    install: async () => "fake-child",
    recordGood: async (commit, appDataDir) => recorded.push({ commit, appDataDir }),
    rollback: async () => {
      throw new Error("should not be called");
    },
    log: () => {},
    warn: () => {},
    error: () => {},
  });
  assert.equal(result.child, "fake-child");
  assert.equal(result.rolledBackTo, null);
  assert.deepEqual(recorded, [{ commit: "commit-a", appDataDir: undefined }]);
});

test("updateAndStart: install failure with no git commit (e.g. a test fixture) just throws", async () => {
  await assert.rejects(
    updateAndStart({
      cwd: "/repo",
      getCommit: async () => {
        throw new Error("not a git repository");
      },
      install: async () => {
        throw new Error("npm install failed");
      },
      rollback: async () => {
        throw new Error("should not be called");
      },
      log: () => {},
      warn: () => {},
      error: () => {},
    }),
    /npm install failed/,
  );
});

test("updateAndStart: install failure with no recorded good commit rethrows the original error", async () => {
  await assert.rejects(
    updateAndStart({
      cwd: "/repo",
      getCommit: async () => "commit-bad",
      install: async () => {
        throw new Error("health check timed out");
      },
      rollback: async () => null,
      recordGood: async () => {
        throw new Error("should not be called");
      },
      log: () => {},
      warn: () => {},
      error: () => {},
    }),
    /health check timed out/,
  );
});

test("updateAndStart: rolls back and retries once when install fails and a good commit is recorded", async () => {
  let installAttempts = 0;
  const warnings = [];
  const result = await updateAndStart({
    cwd: "/repo",
    getCommit: async () => "commit-bad",
    install: async () => {
      installAttempts += 1;
      if (installAttempts === 1) throw new Error("health check timed out");
      return "rolled-back-child";
    },
    rollback: async () => "commit-good",
    recordGood: async () => {
      throw new Error("should not record anything after a rollback retry");
    },
    log: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
  });
  assert.equal(installAttempts, 2);
  assert.equal(result.child, "rolled-back-child");
  assert.equal(result.rolledBackTo, "commit-good");
  assert.match(warnings[0], /last known-good version \(commit-g\)/);
});

test("updateAndStart: throws if the rollback attempt also fails to start", async () => {
  const errors = [];
  await assert.rejects(
    updateAndStart({
      cwd: "/repo",
      getCommit: async () => "commit-bad",
      install: async () => {
        throw new Error("still broken");
      },
      rollback: async () => "commit-good",
      log: () => {},
      warn: () => {},
      error: (msg) => errors.push(msg),
    }),
    /still broken/,
  );
  assert.ok(errors.some((msg) => /also failed to start/.test(msg)));
});

// Regression test for the Windows `import.meta.url === \`file://${process.argv[1]}\``
// entry-point bug (found 2026-10-12, same day as the npm.cmd hotfix above):
// process.argv[1] is a native OS path (backslashes, no file:// prefix on
// Windows), so that bare template comparison can never match there —
// main() silently never ran, with zero output, on real Windows, even
// though it "happened to work" on POSIX. Every test above imports named
// exports, which never exercises this guard (it only fires when the file
// is the process's own directly-invoked entry script) — so this exact gap
// was invisible to every OS in CI, including windows-latest.
//
// Can't spawn the real installers/bootstrap.mjs in place for this: a
// genuine direct run immediately starts real work (install hooks, npm
// install, starting a real server). Instead, copy bootstrap.mjs and its
// two dependencies (rollback.mjs, server/src/dataDir.js — both
// zero-npm-dependency, same constraint bootstrap.mjs itself documents)
// into a scratch dir that mirrors their real relative layout, but
// deliberately omit scripts/install-hooks.js. If the guard passes,
// main()'s first `run("node", [".../scripts/install-hooks.js"])` call
// fails fast with a real, harmless "Cannot find module" error (no
// network, no npm, no server) — proving main() actually ran. If the guard
// were broken, nothing would happen at all: no output, exit code 0.
test("entry-point guard: running a copy of bootstrap.mjs directly for real invokes main()", () => {
  // realpathSync: on macOS, os.tmpdir() resolves through /tmp, which is
  // itself a symlink to /private/tmp. process.argv[1] below would keep the
  // /tmp form the test passed in, while import.meta.url resolves to the
  // real (/private/tmp) path — a mismatch that has nothing to do with the
  // fix under test (a real checkout is never installed under /tmp), but
  // would make even a correctly-fixed guard fail here. Canonicalize first
  // so both sides agree, same as a normal install's non-symlinked path.
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "athena-bootstrap-direct-")));
  try {
    mkdirSync(path.join(scratch, "installers"));
    mkdirSync(path.join(scratch, "server", "src"), { recursive: true });
    copyFileSync(
      path.join(REPO_ROOT_REAL, "installers", "bootstrap.mjs"),
      path.join(scratch, "installers", "bootstrap.mjs"),
    );
    copyFileSync(
      path.join(REPO_ROOT_REAL, "installers", "rollback.mjs"),
      path.join(scratch, "installers", "rollback.mjs"),
    );
    copyFileSync(
      path.join(REPO_ROOT_REAL, "server", "src", "dataDir.js"),
      path.join(scratch, "server", "src", "dataDir.js"),
    );
    // scripts/install-hooks.js deliberately not created.

    const result = (() => {
      try {
        const stdout = execFileSync("node", [path.join(scratch, "installers", "bootstrap.mjs")], {
          cwd: scratch,
          encoding: "utf8",
          timeout: 10_000,
        });
        return { code: 0, stdout, stderr: "" };
      } catch (err) {
        return {
          code: typeof err.status === "number" ? err.status : 1,
          stdout: err.stdout?.toString() ?? "",
          stderr: err.stderr?.toString() ?? "",
        };
      }
    })();

    assert.equal(result.code, 1, `expected a fast module-not-found failure.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Installing git hooks/, "main() should have started running");
    assert.match(result.stderr, /Athena-Studying install failed/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
