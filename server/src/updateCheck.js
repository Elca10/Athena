// "Is there an update?" (one-click updates, step a). Installed copies track
// the `release` branch (installers/macos.sh / windows.ps1, same
// ATHENA_UPDATE_BRANCH override), so this fetches that branch and compares
// it to the commit the checkout is on. Read-only: it never moves the
// checkout. Applying an update is a separate, later step.
//
// Failure is quiet on purpose: offline, GitHub down, or git missing all
// mean "no update right now", never an error banner. The message is still
// kept in `error` for diagnostics.

import { runCommand } from "./processUtil.js";

export const DEFAULT_UPDATE_BRANCH = "release";
export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export function updateBranch(env = process.env) {
  return env.ATHENA_UPDATE_BRANCH || DEFAULT_UPDATE_BRANCH;
}

async function git(args, { cwd, run, timeoutMs = 10_000 }) {
  // Never let git sit waiting on a credential prompt nobody can see.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const result = await run("git", args, { cwd, env, timeoutMs });
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().split("\n")[0]}`);
  }
  return result.stdout.trim();
}

/** The release tag (vX.Y.Z) on exactly `commit`, or null — a commit pushed
 * to the branch some other way just has no name to show. */
async function releaseTagAt(commit, { repoDir, run }) {
  try {
    return await git(["describe", "--tags", "--exact-match", "--match", "v*", commit], { cwd: repoDir, run });
  } catch {
    return null;
  }
}

/**
 * Fetches `branch` from origin and reports whether it is ahead of HEAD.
 * `available` is true only when HEAD is a strict ancestor of the fetched
 * commit, i.e. a fast-forward is possible. A checkout that's ahead or has
 * diverged (a dev clone) is never offered an "update". `run` is injectable
 * for tests; the real one goes through processUtil (windowsHide).
 */
export async function checkForUpdate({ repoDir, branch = updateBranch(), run = runCommand, now = () => new Date() }) {
  const checkedAt = now().toISOString();
  let current = null;
  try {
    current = await git(["rev-parse", "HEAD"], { cwd: repoDir, run });
    // --tags: a branch fetch alone doesn't bring the release tags along,
    // and they're what names a version (latestVersion below, and the
    // running version once the update is applied — bugReport.js).
    await git(["fetch", "--quiet", "--tags", "origin", branch], { cwd: repoDir, run, timeoutMs: FETCH_TIMEOUT_MS });
    const latest = await git(["rev-parse", `refs/remotes/origin/${branch}`], { cwd: repoDir, run });
    const latestVersion = await releaseTagAt(latest, { repoDir, run });
    if (latest === current) return { available: false, current, latest, latestVersion, checkedAt };
    const ancestor = await run("git", ["merge-base", "--is-ancestor", current, latest], { cwd: repoDir, timeoutMs: 10_000 });
    return { available: ancestor.code === 0, current, latest, latestVersion, checkedAt };
  } catch (err) {
    return { available: false, current, latest: null, checkedAt, error: err.message };
  }
}

/**
 * Holds the latest result and serializes checks: a manual "check now"
 * while the periodic one is still fetching joins that one instead of
 * starting a second `git fetch` on the same repo.
 */
export function makeUpdateChecker({ repoDir, branch, check = checkForUpdate, intervalMs = CHECK_INTERVAL_MS } = {}) {
  let status = { available: false, current: null, latest: null, checkedAt: null };
  let inFlight = null;
  let timer = null;

  function checkNow() {
    if (!inFlight) {
      inFlight = check({ repoDir, ...(branch ? { branch } : {}) })
        .then((result) => {
          status = result;
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    getStatus: () => status,
    checkNow,
    /** Checks once now, then every `intervalMs`. The timer is unref'd so it
     * never keeps the process alive on its own. */
    start() {
      if (timer) return;
      checkNow();
      timer = setInterval(checkNow, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
