#!/usr/bin/env node
// One-click self-update (the "Update now" button). The running server
// starts this as a DETACHED process (server/src/updateApply.js), finishes
// its in-flight work, and exits. This script then:
//   1. waits for the old server to have fully exited (on Windows its
//      node_modules files stay locked until it has),
//   2. records the commit it was running as the last known-good one,
//   3. fast-forwards the checkout to origin/<update branch>,
//   4. hands off to bootstrap.mjs's updateAndStart: npm install, build,
//      start the new server, health-check it for its exact commit, and on
//      failure roll back to the last good commit and start that instead,
//   5. writes the outcome to <data dir>/updater/last-update.json for the UI.
//
// It only ever touches the checkout and the updater/ + logs/ dirs. The
// user's data (db/, content/) lives outside the checkout (dataDir.js) and
// no step here reads or writes it.
//
// No npm dependencies, same as bootstrap.mjs and rollback.mjs: this runs
// while server/node_modules is being replaced underneath it. And no
// dynamic imports: every module is loaded before the checkout moves, so
// this process keeps running the code it started with.

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, updateAndStart } from "./bootstrap.mjs";
import { recordGoodCommit } from "./rollback.mjs";
import { getAppDataDir, lastUpdatePath } from "../server/src/dataDir.js";
import { writeJsonAtomic } from "../server/src/atomicJson.js";

const LOCKFILES = new Set(["package-lock.json", "server/package-lock.json", "web/package-lock.json"]);

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export function runGit(args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/** `process.kill(pid, 0)` sends no signal; it only checks the pid exists.
 * EPERM means it exists but belongs to someone else, which still counts. */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export async function waitForExit(pid, { timeoutMs = 60_000, pollMs = 200, isAlive = isProcessAlive } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`The running copy of Athena (pid ${pid}) didn't stop.`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Moves the checkout to origin/<branch>, only as a fast-forward. Lockfiles
 * that `npm install` rewrote are restored first; any other local change
 * means this isn't a plain install, so it refuses rather than overwrite it.
 * Returns the commit now checked out.
 */
export async function moveToLatest({ cwd, branch, git = runGit }) {
  // --tags: the release tags name each version (see server/src/bugReport.js).
  await git(["fetch", "--quiet", "--tags", "origin", branch], { cwd });
  const target = await git(["rev-parse", `refs/remotes/origin/${branch}`], { cwd });
  const head = await git(["rev-parse", "HEAD"], { cwd });
  if (target === head) return target;
  try {
    await git(["merge-base", "--is-ancestor", head, target], { cwd });
  } catch {
    throw new Error(`This copy has commits that aren't on ${branch}, so it can't be updated automatically.`);
  }

  // Tracked files changed vs HEAD (staged or not). Untracked files are
  // left alone and don't block a fast-forward unless upstream adds the
  // same path, in which case the checkout below fails safely.
  const dirty = (await git(["diff", "--name-only", "HEAD"], { cwd })).split("\n").filter(Boolean);
  const unexpected = dirty.filter((file) => !LOCKFILES.has(file));
  if (unexpected.length) {
    throw new Error(`This copy has local changes (${unexpected.join(", ")}), so it can't be updated automatically.`);
  }
  if (dirty.length) await git(["checkout", "--", ...dirty], { cwd });

  await git(["checkout", "-B", branch, `refs/remotes/origin/${branch}`], { cwd });
  return target;
}

/**
 * The whole update. Every outcome ends with SOMETHING running if at all
 * possible: the new version, or the version it started from. All
 * dependencies are injectable for tests; the real end-to-end path is
 * covered by installers/__tests__/updater-e2e.test.js.
 */
export async function runUpdate({
  cwd = REPO_ROOT,
  pid,
  branch,
  port,
  env = process.env,
  appDataDir = getAppDataDir(),
  waitExit = waitForExit,
  git = runGit,
  start = updateAndStart,
  recordGood = recordGoodCommit,
  writeResult = (value) => writeJsonAtomic(lastUpdatePath(appDataDir), value),
} = {}) {
  const outcome = { from: null, to: null, startedAt: new Date().toISOString() };
  const finish = async (fields) => {
    Object.assign(outcome, fields, { finishedAt: new Date().toISOString() });
    log(`Result: ${JSON.stringify(outcome)}`);
    await writeResult(outcome);
    return outcome;
  };
  const healthUrl = `http://127.0.0.1:${port}/api/health`;

  if (pid) {
    log(`Waiting for the running server (pid ${pid}) to exit...`);
    try {
      await waitExit(pid);
    } catch (err) {
      // It's still running, so nothing was touched and nothing needs restarting.
      return finish({ result: "failed", error: err.message });
    }
  }

  outcome.from = await git(["rev-parse", "HEAD"], { cwd });
  // The old server was healthy right up to the click, so it's a safe
  // fallback even if it was never recorded (e.g. started by hand).
  await recordGood(outcome.from, appDataDir);

  let moveError = null;
  try {
    log(`Updating ${outcome.from.slice(0, 8)} to origin/${branch}...`);
    outcome.to = await moveToLatest({ cwd, branch, git });
  } catch (err) {
    moveError = err;
    log(`Couldn't move the checkout: ${err.message}`);
    const head = await git(["rev-parse", "HEAD"], { cwd }).catch(() => null);
    if (head !== outcome.from) await git(["checkout", "--detach", outcome.from], { cwd }).catch(() => {});
  }

  try {
    const { rolledBackTo } = await start({ cwd, env, healthUrl, appDataDir });
    if (moveError) return finish({ result: "failed", error: moveError.message });
    if (rolledBackTo) return finish({ result: "rolled-back", runningCommit: rolledBackTo });
    return finish({ result: "updated", runningCommit: outcome.to });
  } catch (err) {
    return finish({ result: "failed", error: err.message, notRunning: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key) args[key] = argv[i + 1];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  runUpdate({
    pid: args.pid ? Number(args.pid) : undefined,
    branch: args.branch || process.env.ATHENA_UPDATE_BRANCH || "release",
    port: args.port || process.env.ATHENA_PORT || 4417,
  })
    .then((outcome) => process.exit(outcome.result === "failed" ? 1 : 0))
    .catch((err) => {
      log(`Updater crashed: ${err.stack ?? err.message}`);
      process.exit(1);
    });
}
