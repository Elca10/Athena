// "Update now" (one-click updates, step b), the server's half. The rest
// happens in installers/updater.mjs, which this starts as a detached
// process just before exiting.
//
// Data safety comes from the order of operations:
//   1. Refuse outright while a model turn is running (a Live question or
//      grading, or a content scan), with a plain reason, so nothing the
//      user is waiting on gets cut off halfway.
//   2. Stop accepting new requests (503 with a plain message), except the
//      read-only health/update-status calls the UI polls.
//   3. Wait for every request already in flight to finish. Every store
//      write and model call happens inside a request (none are fire-and-
//      forget), so this also covers them. Then wait for store writes to
//      be idle, as a backstop.
//   4. Start the detached updater, then exit. Interrupted sessions come
//      back as Waiting on the next start (sessions.js
//      reconcileInterruptedSessions).
// If step 3 times out, the update is cancelled and the server carries on.

import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { activeModelCalls } from "./processUtil.js";
import { waitForWritesIdle } from "./store/jsonFileStore.js";
import { appDataSubdirs, lastUpdatePath } from "./dataDir.js";
import { readJson, writeJsonAtomic } from "./atomicJson.js";

export const DRAINING_MESSAGE = "Athena is restarting to update. It'll be back in about a minute.";
const DRAIN_TIMEOUT_MS = 2 * 60 * 1000;

export function readLastUpdate(appDataDir) {
  return readJson(lastUpdatePath(appDataDir), null).catch(() => null);
}

/** Starts installers/updater.mjs detached (it must outlive this process),
 * hidden on Windows, with its output appended to logs/updater.log. */
export function spawnUpdater({ repoDir, appDataDir, port, branch, pid = process.pid }) {
  const logsDir = appDataSubdirs(appDataDir).logs;
  mkdirSync(logsDir, { recursive: true });
  const fd = openSync(path.join(logsDir, "updater.log"), "a");
  try {
    const child = spawn(
      process.execPath,
      [path.join(repoDir, "installers", "updater.mjs"), "--pid", String(pid), "--port", String(port), "--branch", branch],
      { cwd: appDataDir, detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env: process.env },
    );
    child.unref();
  } finally {
    closeSync(fd);
  }
}

function allowedWhileDraining(req) {
  if (req.method !== "GET") return false;
  return req.path.startsWith("/health") || req.path.startsWith("/update");
}

export function makeUpdateApplier({
  checker,
  repoDir,
  appDataDir,
  port,
  branch,
  launchUpdater = spawnUpdater,
  exit = () => setTimeout(() => process.exit(0), 100),
  modelCalls = activeModelCalls,
  waitWrites = waitForWritesIdle,
  drainTimeoutMs = DRAIN_TIMEOUT_MS,
  pollMs = 50,
}) {
  let draining = false;
  let activeRequests = 0;

  /** Mounted on /api before every router: counts in-flight requests and
   * turns new ones away while draining. */
  function middleware(req, res, next) {
    if (draining && !allowedWhileDraining(req)) {
      res.status(503).json({ error: DRAINING_MESSAGE });
      return;
    }
    activeRequests++;
    let counted = true;
    const done = () => {
      if (counted) {
        counted = false;
        activeRequests--;
      }
    };
    res.on("finish", done);
    res.on("close", done);
    next();
  }

  function blockedReason() {
    if (draining) return "An update is already in progress.";
    if (modelCalls() > 0) {
      return "Athena is in the middle of working on something (a Live question, grading, or reading your content). Try again when it's done.";
    }
    return null;
  }

  async function drainAndHandOff() {
    const deadline = Date.now() + drainTimeoutMs;
    try {
      while (activeRequests > 0 || modelCalls() > 0) {
        if (Date.now() > deadline) throw new Error("Athena was still busy after two minutes, so the update was cancelled.");
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      await waitWrites();
    } catch (err) {
      draining = false;
      await writeJsonAtomic(lastUpdatePath(appDataDir), {
        result: "cancelled",
        error: err.message,
        finishedAt: new Date().toISOString(),
      }).catch(() => {});
      return { handedOff: false, error: err.message };
    }
    launchUpdater({ repoDir, appDataDir, port, branch });
    exit();
    return { handedOff: true };
  }

  /** Returns `{ok: false, reason}` when it won't update, otherwise
   * `{ok: true, from, to, done}` where `done` settles once the hand-off
   * happened (or was cancelled). Draining starts before this returns, so no
   * new request can slip in between the check and the hand-off. */
  async function apply() {
    const reason = blockedReason();
    if (reason) return { ok: false, reason };
    const status = await checker.checkNow();
    if (!status.available) return { ok: false, reason: "Athena is already up to date." };
    const again = blockedReason(); // a model turn may have started during the fetch
    if (again) return { ok: false, reason: again };
    draining = true;
    return { ok: true, from: status.current, to: status.latest, done: drainAndHandOff() };
  }

  return { middleware, apply, blockedReason, isDraining: () => draining };
}
