#!/usr/bin/env node
// Fast-forwards the `release` branch to a given `main` commit (ship queue
// item 3.5: installed copies auto-update from `release`, not `main`, so
// nothing reaches a friend's machine until the maintainer deliberately
// promotes it — see installers/macos.sh and installers/windows.ps1's
// ATHENA_UPDATE_BRANCH). Only promotes a commit whose CI run has actually
// finished green, and never force-pushes: a plain `git push` without
// `--force` is itself the enforcement, since git refuses a non-fast-forward
// update on its own.
//
// Usage: node scripts/promote-release.mjs <commit-sha>
//
// CI status is read from GitHub's public Actions API — no `gh` and no
// token needed, same reasoning as the check-run-annotations technique
// already used elsewhere in this build (see ~/athena-build/progress.md,
// priority item 0): a public repo's read endpoints work unauthenticated.

import { execFileSync } from "node:child_process";

const REPO = "Elca10/Athena";
const API_BASE = `https://api.github.com/repos/${REPO}`;

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function defaultFetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) {
    throw new Error(`GitHub API request to ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * True only if the MOST RECENT workflow run against this exact commit has
 * finished with every job green. A run still queued/in-progress, or whose
 * most recent attempt failed or was cancelled, is not green — and a commit
 * with no runs at all (never pushed, or pushed somewhere CI doesn't cover)
 * is never treated as green by default. `fetchJsonFn` is injectable for
 * tests, same DI pattern as installers/bootstrap.mjs's `fetchFn`.
 */
export async function isCommitCiGreen(commit, { fetchJsonFn = defaultFetchJson } = {}) {
  const { workflow_runs: runs } = await fetchJsonFn(`${API_BASE}/actions/runs?head_sha=${commit}&per_page=10`);
  if (!runs || runs.length === 0) return false;
  const [latest] = [...runs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return latest.status === "completed" && latest.conclusion === "success";
}

/**
 * Does the actual promotion: resolves `commit` to a full SHA, checks CI is
 * green for it, and — only if so — pushes it to `release` with no
 * `--force`, so git itself rejects anything that isn't a fast-forward
 * rather than this script deciding that on its own. Returns a result
 * object instead of throwing/exiting, so `main()` below is the only place
 * that touches process.exit — everything here stays testable without a
 * real GitHub push.
 */
export async function promoteRelease(
  commit,
  { checkCiGreen = isCommitCiGreen, runFn = runGit, log = console.log, error = console.error } = {},
) {
  runFn(["fetch", "origin", "main", "release"]);

  let full;
  try {
    full = runFn(["rev-parse", commit]);
  } catch {
    return { promoted: false, reason: "unknown-commit", commit };
  }

  const green = await checkCiGreen(full);
  if (!green) {
    error(`CI is not green for ${full} — refusing to promote.`);
    return { promoted: false, reason: "ci-not-green", commit: full };
  }

  try {
    runFn(["push", "origin", `${full}:release`]);
  } catch (err) {
    error(
      `Push rejected — ${full} is not a fast-forward of origin/release. Never force-pushing; ` +
        `resolve this manually if that's really what you intend. (${err.message})`,
    );
    return { promoted: false, reason: "not-fast-forward", commit: full };
  }

  log(`Promoted release to ${full}.`);
  return { promoted: true, commit: full };
}

async function main() {
  const commit = process.argv[2];
  if (!commit) {
    console.error("Usage: node scripts/promote-release.mjs <commit-sha>");
    process.exit(1);
  }
  const result = await promoteRelease(commit);
  process.exit(result.promoted ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
