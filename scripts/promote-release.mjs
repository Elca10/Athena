#!/usr/bin/env node
// Ships a release: fast-forwards the `release` branch to a given `main`
// commit AND tags that commit with the next semver version (vX.Y.Z), in
// one atomic push. Installed copies auto-update from `release`, not
// `main` (see installers/macos.sh and installers/windows.ps1's
// ATHENA_UPDATE_BRANCH), so nothing reaches a friend's machine until the
// maintainer deliberately promotes it. The tag is the product's version:
// pushing it triggers .github/workflows/release.yml, which publishes a
// GitHub Release whose notes are the tag's message: the user-facing notes
// added under release-notes/ since the previous version (see
// release-notes/README.md), then every commit subject, folded away.
//
// Only promotes a commit whose CI run has actually finished green, and
// never force-pushes: a plain `git push` without `--force` is itself the
// enforcement, since git refuses a non-fast-forward update on its own —
// and `--atomic` means the branch never moves without its tag, or the
// tag lands without the branch.
//
// Usage: node scripts/promote-release.mjs <commit-sha> [--minor | --major]
// With no flag, the bump comes from the commits being shipped: a
// `Release: minor` or `Release: major` trailer on any of them picks that
// bump (the highest wins), otherwise it's a patch (v0.1.0 -> v0.1.1).
//
// Normally this runs on its own: .github/workflows/promote.yml calls it
// for every `main` commit whose CI finishes green, so the trailer is how
// a commit asks for a minor/major release. Running it by hand still works
// (e.g. for a hotfix commit that isn't on main).
//
// CI status is read from GitHub's public Actions API — no `gh` and no
// token needed (GITHUB_TOKEN is sent if set, only for the higher rate
// limit inside Actions), same reasoning as the check-run-annotations technique
// already used elsewhere in this build (see ~/athena-build/progress.md,
// priority item 0): a public repo's read endpoints work unauthenticated.
// Creating the GitHub Release itself does need auth, which is exactly why
// that half lives in the workflow (its built-in GITHUB_TOKEN) instead.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REPO = "Elca10/Athena";
const API_BASE = `https://api.github.com/repos/${REPO}`;
export const FIRST_VERSION = "v0.1.0";
const VERSION_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
// Only CI's own runs say whether a commit is green. Other workflows run
// against the same SHA too — promote.yml itself, still in progress while
// it asks — and counting them would make every automatic promotion
// refuse.
const CI_WORKFLOW = "ci.yml";
const BUMPS = ["patch", "minor", "major"];
// release-notes/<section>/<anything>.md, in the order a reader wants them.
const NOTE_SECTIONS = [
  ["new", "New"],
  ["improved", "Improved"],
  ["fixed", "Fixed"],
];
const NOTE_PATH_RE = /^release-notes\/([a-z]+)\/[^/]+\.md$/;
const HOW_TO_UPDATE =
  "**Getting it:** Athena updates itself. Within about half an hour an **Update available** button " +
  "appears at the top of the dashboard; click **Update now** and wait about a minute. Your subjects " +
  "and progress are kept.";

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
}

async function defaultFetchJson(url) {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API request to ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * True only if the MOST RECENT CI run against this exact commit has
 * finished with every job green. A run still queued/in-progress, or whose
 * most recent attempt failed or was cancelled, is not green — and a commit
 * with no runs at all (never pushed, or pushed somewhere CI doesn't cover)
 * is never treated as green by default. `fetchJsonFn` is injectable for
 * tests, same DI pattern as installers/bootstrap.mjs's `fetchFn`.
 */
export async function isCommitCiGreen(commit, { fetchJsonFn = defaultFetchJson } = {}) {
  const { workflow_runs: runs } = await fetchJsonFn(
    `${API_BASE}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${commit}&per_page=10`,
  );
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

/**
 * The bump asked for by `Release:` trailer values (one per line, as
 * `git log --format=%(trailers:key=Release,valueonly)` prints them): the
 * highest of minor/major, else patch. Anything else is ignored.
 */
export function bumpFromTrailers(out) {
  const asked = splitLines(out).map((v) => v.toLowerCase());
  return BUMPS.filter((b) => asked.includes(b)).pop() ?? "patch";
}

/**
 * The release notes for one version, as Markdown: the user-facing notes
 * grouped under New / Improved / Fixed, how to get the update, then every
 * commit subject in a collapsed block for anyone who wants the detail.
 * `notes` maps a section key (see NOTE_SECTIONS) to note texts; each
 * becomes one bullet, with any further lines indented to stay inside it.
 */
export function formatReleaseNotes({ notes = {}, subjects = [] }) {
  const parts = [];
  for (const [key, heading] of NOTE_SECTIONS) {
    const items = (notes[key] ?? []).map((n) => n.trim()).filter(Boolean);
    if (items.length === 0) continue;
    const bullets = items.map((n) => {
      const [first, ...rest] = n.replace(/^[-*]\s+/, "").split("\n");
      return [`- ${first}`, ...rest.map((l) => (l.trim() ? `  ${l}` : ""))].join("\n");
    });
    parts.push(`## ${heading}\n\n${bullets.join("\n")}`);
  }
  if (parts.length === 0) parts.push("Behind-the-scenes changes only. Nothing you'll notice while studying.");
  parts.push(HOW_TO_UPDATE);
  const changes = subjects.length ? subjects.map((s) => `- ${s}`).join("\n") : "- No code changes.";
  parts.push(`<details>\n<summary>Every change in this release</summary>\n\n${changes}\n\n</details>`);
  return parts.join("\n\n");
}

/** True for a note file in one of NOTE_SECTIONS' folders. */
export function isReleaseNotePath(file) {
  const m = NOTE_PATH_RE.exec(file);
  return Boolean(m) && NOTE_SECTIONS.some(([key]) => key === m[1]);
}

/**
 * The note files added between `previous` and `full`, read as of `full`
 * and grouped by section. Only files *added* in the range count, so a
 * note ships exactly once and later edits or deletions never resurface
 * it; a file outside a known section is ignored (a test keeps the
 * repo's own release-notes/ free of those).
 */
function collectNotes(runFn, previous, full) {
  const notes = {};
  const added = splitLines(
    runFn(["diff", "--name-only", "--diff-filter=A", "--no-renames", previous, full, "--", "release-notes"]),
  );
  for (const file of added.sort()) {
    if (!isReleaseNotePath(file)) continue;
    const [, section] = NOTE_PATH_RE.exec(file);
    (notes[section] ??= []).push(runFn(["show", `${full}:${file}`]));
  }
  return notes;
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
  { bump = null, checkCiGreen = isCommitCiGreen, runFn = runGit, log = console.log, error = console.error } = {},
) {
  // --tags: the version tags decide what this release is called, and a
  // plain branch fetch doesn't bring them along.
  runFn(["fetch", "--tags", "origin", "main"]);
  try {
    // Best-effort: on the very first promotion ever, `release` doesn't
    // exist on origin yet, so there's nothing to fetch — the push below
    // creates it fresh, which is a normal ref creation, not something
    // --force is needed for.
    // Explicit destination: the ancestry check below reads
    // origin/release, which a bare `fetch origin release` only updates
    // when the clone has a matching fetch refspec.
    runFn(["fetch", "origin", "+refs/heads/release:refs/remotes/origin/release"]);
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

  // Already shipped as part of a later commit: CI for two quick pushes
  // can finish out of order, and the newer one may have promoted first.
  // Pushing the older commit would be a rewind git refuses anyway, so
  // this is "nothing to do", not a failure.
  let base = null;
  try {
    base = runFn(["merge-base", full, "refs/remotes/origin/release"]);
  } catch {
    // No release yet (first promotion) or no common history — the push
    // below decides.
  }
  if (base === full) {
    error(`${full} is already on release — nothing to do.`);
    return { promoted: false, reason: "already-on-release", commit: full };
  }

  const green = await checkCiGreen(full);
  if (!green) {
    error(`CI is not green for ${full} — refusing to promote.`);
    return { promoted: false, reason: "ci-not-green", commit: full };
  }

  const tags = splitLines(runFn(["tag", "--list", "v*"]));
  const previous = sortedVersionTags(tags).pop();
  const chosenBump =
    bump ??
    (previous
      ? bumpFromTrailers(runFn(["log", "--format=%(trailers:key=Release,valueonly)", `${previous}..${full}`]))
      : "patch");
  const version = nextVersion(tags, chosenBump);
  // The tag's message is the release notes (release.yml publishes it as
  // the GitHub Release body): the user-facing notes added since the
  // previous version, then every commit subject for the detail.
  const notes = previous
    ? formatReleaseNotes({
        notes: collectNotes(runFn, previous, full),
        subjects: splitLines(runFn(["log", "--no-merges", "--format=%s", `${previous}..${full}`])),
      })
    : "First tagged release.";
  // --cleanup=verbatim: git's default cleanup would strip every line
  // starting with "#", i.e. the Markdown section headings.
  runFn(["tag", "-a", "--cleanup=verbatim", version, "-m", notes, full]);

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
  const bump = argv.includes("--major") ? "major" : argv.includes("--minor") ? "minor" : null;
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
  // Hands the new version to promote.yml's publish job.
  if (result.promoted && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\n`);
  }
  const nothingToDo = result.reason === "already-released" || result.reason === "already-on-release";
  process.exit(result.promoted || nothingToDo ? 0 : 1);
}

// pathToFileURL, not a bare `file://${...}` template: process.argv[1] is a
// native OS path, which only pathToFileURL converts the same way Node
// itself builds import.meta.url — the naive template version happens to
// work on POSIX but can never match on Windows.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
