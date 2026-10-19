#!/usr/bin/env node
// Ships a release: fast-forwards the `release` branch to a given `main`
// commit AND tags that commit with the next semver version (vX.Y.Z), in
// one atomic push. Installed copies auto-update from `release`, not
// `main` (see installers/macos.sh and installers/windows.ps1's
// ATHENA_UPDATE_BRANCH), so nothing reaches a friend's machine until the
// maintainer deliberately promotes it. The tag is the product's version:
// pushing it triggers .github/workflows/release.yml, which publishes a
// GitHub Release whose notes are the tag's message (the commit subjects
// since the previous version).
//
// Only promotes a commit whose CI run has actually finished green, and
// never force-pushes: a plain `git push` without `--force` is itself the
// enforcement, since git refuses a non-fast-forward update on its own —
// and `--atomic` means the branch never moves without its tag, or the
// tag lands without the branch.
//
// Usage: node scripts/promote-release.mjs <commit-sha> [--minor | --major]
// (default bump is patch: v0.1.0 -> v0.1.1)
//
// CI status is read from GitHub's public Actions API — no `gh` and no
// token needed, same reasoning as the check-run-annotations technique
// already used elsewhere in this build (see ~/athena-build/progress.md,
// priority item 0): a public repo's read endpoints work unauthenticated.
// Creating the GitHub Release itself does need auth, which is exactly why
// that half lives in the workflow (its built-in GITHUB_TOKEN) instead.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO = "Elca10/Athena";
const API_BASE = `https://api.github.com/repos/${REPO}`;
export const FIRST_VERSION = "v0.1.0";
const VERSION_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
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

/** The vX.Y.Z tags in `tags`, lowest to highest (anything else, e.g. a
 * stray non-semver tag, is ignored). */
function sortedVersionTags(tags) {
  const parse = (t) => VERSION_RE.exec(t).slice(1).map(Number);
  return tags
    .map((t) => t.trim())
    .filter((t) => VERSION_RE.test(t))
    .sort((a, b) => {
      const [x, y] = [parse(a), parse(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
}

/**
 * The version after the highest vX.Y.Z in `tags`. With no version tags
 * yet, the first release is FIRST_VERSION whatever the bump.
 */
export function nextVersion(tags, bump = "patch") {
  const latest = sortedVersionTags(tags).pop();
  if (!latest) return FIRST_VERSION;
  const [major, minor, patch] = VERSION_RE.exec(latest).slice(1).map(Number);
  if (bump === "major") return `v${major + 1}.0.0`;
  if (bump === "minor") return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
}

function splitLines(out) {
  return out ? out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
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
  { bump = "patch", checkCiGreen = isCommitCiGreen, runFn = runGit, log = console.log, error = console.error } = {},
) {
  // --tags: the version tags decide what this release is called, and a
  // plain branch fetch doesn't bring them along.
  runFn(["fetch", "--tags", "origin", "main"]);
  try {
    // Best-effort: on the very first promotion ever, `release` doesn't
    // exist on origin yet, so there's nothing to fetch — the push below
    // creates it fresh, which is a normal ref creation, not something
    // --force is needed for.
    runFn(["fetch", "origin", "release"]);
  } catch {
    // Not fatal — see above.
  }

  let full;
  try {
    full = runFn(["rev-parse", `${commit}^{commit}`]);
  } catch {
    return { promoted: false, reason: "unknown-commit", commit };
  }

  // Re-running for a commit that's already a version would otherwise mint
  // a second, empty version for the same code.
  const existing = sortedVersionTags(splitLines(runFn(["tag", "--points-at", full]))).pop();
  if (existing) {
    error(`${full} is already released as ${existing} — nothing to do.`);
    return { promoted: false, reason: "already-released", commit: full, version: existing };
  }

  const green = await checkCiGreen(full);
  if (!green) {
    error(`CI is not green for ${full} — refusing to promote.`);
    return { promoted: false, reason: "ci-not-green", commit: full };
  }

  const tags = splitLines(runFn(["tag", "--list", "v*"]));
  const version = nextVersion(tags, bump);
  const previous = sortedVersionTags(tags).pop();
  // The tag's message is the release notes (release.yml publishes it as
  // the GitHub Release body): every commit subject since the previous
  // version, which is why commits here are titled for a reader ("Refs #7:
  // rate confidence after answering") — GitHub links the #N refs.
  const changes = previous
    ? splitLines(runFn(["log", "--no-merges", "--format=- %s", `${previous}..${full}`]))
    : [];
  const notes = previous ? changes.join("\n") || "- No code changes." : "First tagged release.";
  runFn(["tag", "-a", version, "-m", notes, full]);

  try {
    // Fully-qualified destination (`refs/heads/release`, not bare
    // `release`): a bare ref name only resolves on push if it already
    // exists on the remote, so the very first promotion ever (nothing to
    // disambiguate against yet) fails outright with "not a full refname"
    // — caught live against a real bare-repo fixture, see this file's
    // "very first promotion" test. --atomic: branch and tag land together
    // or not at all.
    runFn(["push", "--atomic", "origin", `${full}:refs/heads/release`, `refs/tags/${version}`]);
  } catch (err) {
    // Drop the local tag so a re-run computes the version afresh instead
    // of tripping over a tag that never made it to origin.
    try {
      runFn(["tag", "-d", version]);
    } catch {
      // Already gone — nothing to clean up.
    }
    error(
      `Push rejected — ${full} is not a fast-forward of origin/release (or ${version} already exists on origin). ` +
        `Never force-pushing; resolve this manually if that's really what you intend. (${err.message})`,
    );
    return { promoted: false, reason: "not-fast-forward", commit: full };
  }

  log(`Released ${version} (${full}). GitHub Release: https://github.com/${REPO}/releases/tag/${version}`);
  return { promoted: true, commit: full, version };
}

export function parseArgs(argv) {
  const bump = argv.includes("--major") ? "major" : argv.includes("--minor") ? "minor" : "patch";
  const commit = argv.find((a) => !a.startsWith("--"));
  return { commit, bump };
}

async function main() {
  const { commit, bump } = parseArgs(process.argv.slice(2));
  if (!commit) {
    console.error("Usage: node scripts/promote-release.mjs <commit-sha> [--minor | --major]");
    process.exit(1);
  }
  const result = await promoteRelease(commit, { bump });
  process.exit(result.promoted ? 0 : 1);
}

// pathToFileURL, not a bare `file://${...}` template: process.argv[1] is a
// native OS path, which only pathToFileURL converts the same way Node
// itself builds import.meta.url — the naive template version happens to
// work on POSIX but can never match on Windows.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
