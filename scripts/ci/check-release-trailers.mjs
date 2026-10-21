#!/usr/bin/env node
// CI guard for the exact mistake that shipped commit 674ba04 as a patch
// instead of a minor: a `Release: minor` trailer separated from the
// commit's final paragraph by a blank line, which git's trailer parser
// silently never reads at all (see scripts/promote-release.mjs's
// findMisplacedReleaseTrailers — the SAME function promote-release.mjs
// itself calls before ever promoting a release, so this CI check and the
// real release gate can never disagree about what counts as malformed).
// This one just runs sooner: at push time, in the author's own CI run,
// instead of silently at promotion time days or weeks later.
//
// Scope: the commits this push actually added. GitHub's push event gives
// the previous branch head as `before` — when that's a real, reachable
// commit, the range is `before..HEAD`. Otherwise (no event payload, e.g. a
// manual/local run; `before` is all-zeros, e.g. a brand-new branch; or
// `before` isn't reachable, e.g. a shallow checkout) this falls back to
// just the last 20 commits reachable from HEAD — wide enough to catch a
// mistake without scanning this repo's entire history on every push.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findMisplacedReleaseTrailers, formatMisplacedReleaseTrailerError } from "../promote-release.mjs";

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
}

function defaultCommitExists(sha) {
  try {
    runGit(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `git log` revision args to check: `[\`${before}..HEAD\`]` when a
 * usable previous-head SHA is available, else `["-20", "HEAD"]`. Exported
 * for testing; `readEventFile`/`commitExists` are injectable so tests
 * don't need a real GitHub event payload or a real git repo.
 */
export function resolveRevArgs({
  eventPath = process.env.GITHUB_EVENT_PATH,
  readEventFile = (p) => readFileSync(p, "utf8"),
  pathExists = existsSync,
  commitExists = defaultCommitExists,
} = {}) {
  const fallback = ["-20", "HEAD"];
  if (!eventPath || !pathExists(eventPath)) return fallback;
  let before;
  try {
    ({ before } = JSON.parse(readEventFile(eventPath)));
  } catch {
    return fallback; // Unreadable/invalid event payload.
  }
  // All-zeros `before`: a brand-new branch's first push has no real
  // previous head to diff against.
  if (!before || /^0+$/.test(before)) return fallback;
  // Shallow checkout (or any other reason `before` isn't fetched): nothing
  // to diff against either, so fall back rather than letting `git log`
  // fail outright.
  if (!commitExists(before)) return fallback;
  return [`${before}..HEAD`];
}

function main() {
  const revArgs = resolveRevArgs();
  const problems = findMisplacedReleaseTrailers(runGit, revArgs);
  if (problems.length > 0) {
    console.error(
      `Malformed Release: trailer — this would silently mis-version the next automatic release promotion:\n` +
        `${formatMisplacedReleaseTrailerError(problems)}`,
    );
    process.exit(1);
  }
  console.log(`Release trailer check: no malformed "Release:" lines found (git log ${revArgs.join(" ")}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
