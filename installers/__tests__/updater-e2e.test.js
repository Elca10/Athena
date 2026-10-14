// End-to-end test of one-click updates, on the REAL path: a scratch bare
// "origin" holding this repo's own HEAD as `release`, a scratch install
// cloned from it and started by the real installers/bootstrap.mjs (real npm
// install, real web build, real detached server), and a scratch data dir.
// Then a real POST /api/update/apply, through the real detached updater.
//
// Two updates are applied: a good one (the new commit must be what
// answers) and a broken one (it must roll back to the good one). After
// each, the user's data (db/ and content/) must be byte-identical.
//
// Slow (several real npm installs and builds), so it only runs with
// ATHENA_E2E=1 (a dedicated CI step on every OS). Never touches the real
// remote, the real data dir, or the real release branch.
//
// Locally: commit first. The scratch origin gets HEAD, not the working tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ENABLED = process.env.ATHENA_E2E === "1";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** relative path -> file contents, for every file under `dir`. */
function snapshot(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) snapshot(full, base, out);
    else out[path.relative(base, full)] = readFileSync(full).toString("base64");
  }
  return out;
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

async function waitFor(what, fn, { timeoutMs, intervalMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last?.message ?? JSON.stringify(last)})`);
}

test("one-click update: applies a real update, rolls back a broken one, never touches user data", { skip: !ENABLED && "set ATHENA_E2E=1", timeout: 30 * 60 * 1000 }, async () => {
  // realpath: macOS's tmpdir is a symlink, and paths get compared below.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "athena-update-e2e-")));
  const origin = path.join(root, "origin.git");
  const installed = path.join(root, "installed");
  const maintainer = path.join(root, "maintainer");
  const dataDir = path.join(root, "data");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  let lastPid = null;

  try {
    // Origin = this repo's HEAD as `release`. shallowUpdate: CI checkouts
    // are shallow, and a shallow push is otherwise refused.
    execFileSync("git", ["init", "-q", "--bare", origin]);
    git(origin, "config", "receive.shallowUpdate", "true");
    git(REPO_ROOT, "push", "-q", "--no-verify", origin, "HEAD:refs/heads/release");
    execFileSync("git", ["clone", "-q", "--branch", "release", origin, installed]);
    execFileSync("git", ["clone", "-q", "--branch", "release", origin, maintainer]);
    // core.autocrlf deliberately left at the machine default (true on
    // Windows runners), the same as a real install.
    for (const dir of [installed, maintainer]) {
      git(dir, "config", "user.email", "test@example.com");
      git(dir, "config", "user.name", "Test");
    }
    const first = git(installed, "rev-parse", "HEAD");

    // User data that must survive both updates byte for byte. No "active"
    // session, since a restart legitimately moves those to "waiting".
    mkdirSync(path.join(dataDir, "db"), { recursive: true });
    mkdirSync(path.join(dataDir, "content", "raw"), { recursive: true });
    writeFileSync(
      path.join(dataDir, "db", "subjects.json"),
      JSON.stringify([{ id: "s1", name: "Operating Systems", archived: false, createdAt: "2026-10-13T00:00:00.000Z" }], null, 2),
    );
    writeFileSync(
      path.join(dataDir, "db", "sessions.json"),
      JSON.stringify(
        [{ id: "x1", subjectIds: ["s1"], topicIds: [], mode: "ready", status: "waiting", currentQuestion: { prompt: "What is a mutex?" }, history: [] }],
        null,
        2,
      ),
    );
    writeFileSync(path.join(dataDir, "content", "raw", "notes.txt"), "Mutexes guard critical sections.\n");
    writeFileSync(path.join(dataDir, "setup-complete.json"), JSON.stringify({ complete: true }));
    const userData = () => ({ db: snapshot(path.join(dataDir, "db")), content: snapshot(path.join(dataDir, "content")) });
    const before = userData();

    const env = {
      ...process.env,
      ATHENA_PORT: String(port),
      ATHENA_DATA_DIR: dataDir,
      ATHENA_NO_OPEN_BROWSER: "1",
      ATHENA_UPDATE_BRANCH: "release",
    };

    // 1. A real install + start, exactly as the installers hand off.
    await promisify(execFile)(process.execPath, [path.join(installed, "installers", "bootstrap.mjs")], {
      cwd: installed,
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    let health = (await getJson(`${base}/health`)).body;
    assert.equal(health.commit, first);
    lastPid = health.pid;

    // 2. A good update.
    writeFileSync(path.join(maintainer, "UPDATE_MARKER.txt"), "update 1\n");
    git(maintainer, "add", "-A");
    git(maintainer, "commit", "-q", "-m", "good update");
    git(maintainer, "push", "-q", "origin", "release");
    const good = git(maintainer, "rev-parse", "HEAD");

    const applied = await getJson(`${base}/update/apply`, { method: "POST" });
    assert.equal(applied.status, 202, JSON.stringify(applied.body));
    assert.equal(applied.body.to, good);
    health = await waitFor("the updated server", async () => {
      const h = (await getJson(`${base}/health`)).body;
      return h.commit === good ? h : null;
    }, { timeoutMs: 15 * 60 * 1000 });
    assert.notEqual(health.pid, lastPid, "a new process must be answering");
    lastPid = health.pid;
    const status = (await getJson(`${base}/update/status`)).body;
    assert.equal(status.lastUpdate.result, "updated");
    assert.equal(status.lastUpdate.from, first);
    assert.deepEqual(userData(), before, "user data must be byte-identical after an update");

    // 3. A broken update: the server can't start, so it must roll back.
    const indexPath = path.join(maintainer, "server", "src", "index.js");
    writeFileSync(indexPath, `throw new Error("deliberately broken by the e2e test");\n${readFileSync(indexPath, "utf8")}`);
    git(maintainer, "add", "-A");
    git(maintainer, "commit", "-q", "-m", "broken update");
    git(maintainer, "push", "-q", "origin", "release");

    const appliedBroken = await getJson(`${base}/update/apply`, { method: "POST" });
    assert.equal(appliedBroken.status, 202, JSON.stringify(appliedBroken.body));
    const rolledBack = await waitFor("the rollback to finish", async () => {
      const s = (await getJson(`${base}/update/status`)).body;
      return s.lastUpdate?.result === "rolled-back" ? s : null;
    }, { timeoutMs: 20 * 60 * 1000, intervalMs: 2000 });
    assert.equal(rolledBack.lastUpdate.runningCommit, good);
    health = (await getJson(`${base}/health`)).body;
    assert.equal(health.commit, good, "the last good version must be the one running");
    lastPid = health.pid;
    assert.deepEqual(userData(), before, "user data must be byte-identical after a rolled-back update");
  } finally {
    if (lastPid) {
      try {
        process.kill(lastPid);
      } catch {
        // already gone
      }
    }
    // Give Windows a moment to release file locks before deleting.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
