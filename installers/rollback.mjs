// Auto-update rollback (SPEC.md section 2): tracks the last commit that
// started up and passed a health check, so a bad push to `main` can't
// strand a friend on a broken install. State lives under the app-data
// updater/ dir (server/src/dataDir.js) — never in the repo checkout, same
// as every other piece of user/install state in this app.
//
// Deliberately only ever moves the checkout to a specific known commit
// (`git checkout --detach <sha>`) rather than resetting the `main` branch
// itself: the next launch's normal fetch + fast-forward-merge
// (installers/macos.sh) re-attaches to `main` and tries the newest commit
// again on its own, so a rollback is a per-launch safety net, not a
// persistent downgrade.
//
// No npm dependencies, same constraint as bootstrap.mjs — this runs before
// `npm install` has put anything on disk. server/src/dataDir.js is safe to
// import directly: it has no npm dependencies of its own either.

import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { appDataSubdirs, getAppDataDir } from "../server/src/dataDir.js";

function runGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
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

/** Current commit SHA of `cwd`'s checkout. `runFn` is injectable for tests. */
export async function getCurrentCommit(cwd, { runFn = runGit } = {}) {
  return runFn(["rev-parse", "HEAD"], { cwd });
}

function statePath(appDataDir) {
  return path.join(appDataSubdirs(appDataDir).updater, "state.json");
}

export async function readUpdateState(appDataDir = getAppDataDir()) {
  try {
    return JSON.parse(await fs.readFile(statePath(appDataDir), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Called once a launch on `commit` has been verified healthy — records it
 * as the version to fall back to if a future update ever fails to start. */
export async function recordGoodCommit(commit, appDataDir = getAppDataDir()) {
  await fs.mkdir(appDataSubdirs(appDataDir).updater, { recursive: true });
  const state = { lastGoodCommit: commit, recordedAt: new Date().toISOString() };
  await fs.writeFile(statePath(appDataDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

/**
 * Moves `cwd`'s checkout to the last recorded known-good commit, if any.
 * Returns the commit SHA rolled back to, or `null` if none has ever been
 * recorded (e.g. the very first launch ever fails — nothing to fall back
 * to). `runFn` is injectable for tests.
 */
export async function rollbackToLastGoodCommit({ cwd, appDataDir = getAppDataDir(), runFn = runGit } = {}) {
  const state = await readUpdateState(appDataDir);
  if (!state?.lastGoodCommit) return null;
  await runFn(["checkout", "--detach", state.lastGoodCommit], { cwd });
  return state.lastGoodCommit;
}
