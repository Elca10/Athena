#!/usr/bin/env node
// Privacy guard (SPEC.md section 3 — "be VIGILANT", "treat any leak as a
// severity-1 bug"). This repo is PUBLIC and the bug fixer (section 10)
// commits and pushes autonomously with no human review gate, so this check
// is the actual safety net, run from two places that must stay in sync:
//   - .githooks/pre-commit, checking what's about to be committed
//   - .github/workflows/ci.yml, checking every push/PR against the whole
//     tracked tree (catches anything that slipped through a bypassed or
//     missing local hook — e.g. `git commit --no-verify`, or a contributor
//     who never ran scripts/install-hooks.js)
// One shared implementation so the two checks can never drift apart.
//
// Two kinds of violation, both block:
//   1. STRUCTURAL — a changed/tracked file's path isn't on the source/test
//      allowlist below (SPEC.md: "files outside an allowlist of source
//      paths"). Default-deny: anything not explicitly recognized as source,
//      tests, config, docs, or CI/tooling is rejected, including (this is
//      the point) any data file that would otherwise slip in unnoticed.
//   2. CONTENT — an allowed text file's contents match a known
//      personal-data pattern (SPEC.md: "emails, file paths with usernames,
//      etc."). Deliberately narrow and literal rather than a broad
//      "anything path-shaped" regex, which would false-positive on this
//      codebase's own cross-platform path-handling tests (e.g.
//      dataDir.test.js intentionally constructs fake paths like
//      "/home/friend" or "/Users/someone" — those are fine, they're not
//      anyone's real data).
//
// Usage:
//   node scripts/check-privacy.js --staged   (pre-commit: checks the index)
//   node scripts/check-privacy.js            (CI: checks the full tracked tree)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

// Path allowlist — everything that's allowed to exist in this repo at all.
// Matched against the repo-relative, forward-slash path git reports.
const ALLOWED_PATH_PATTERNS = [
  /^README\.md$/,
  /^SPEC\.md$/,
  /^LICENSE(\.[A-Za-z0-9]+)?$/,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^\.github\/.+/,
  /^\.githooks\/.+/,
  /^scripts\/.+\.(js|mjs|sh|ps1)$/,
  /^installers\/.+\.(sh|ps1|js|mjs)$/,
  /^server\/package(-lock)?\.json$/,
  /^server\/src\/.+\.js$/,
  /^server\/scripts\/[^/]+\.js$/,
  /^web\/package(-lock)?\.json$/,
  /^web\/index\.html$/,
  /^web\/.*\.(json|js|ts|tsx|css)$/,
  /^web\/public\/.+/,
  /^web\/src\/.+\.(ts|tsx|css)$/,
];

function isPathAllowed(relPath) {
  return ALLOWED_PATH_PATTERNS.some((re) => re.test(relPath));
}

// Content patterns. Each has a human-readable `label` for the error
// message and either a `test(text)` predicate or a plain `pattern` regex
// tested globally. Kept literal/specific on purpose — see module docstring.
const SAFE_EMAIL_DOMAINS = ["example.com", "example.org", "example.net"];
const SAFE_PATH_NAMES = ["someone", "friend", "test", "tester", "user", "example", "you", "name"];
// Git hosts' SSH clone-URL syntax (`git@github.com:org/repo.git`) is
// syntactically email-shaped but isn't anyone's personal address — this
// repo's own README/installers legitimately reference it.
const GIT_HOST_DOMAINS = ["github.com", "gitlab.com", "bitbucket.org"];

function findEmailLeak(text) {
  const re = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  let m;
  while ((m = re.exec(text))) {
    const domain = m[1].toLowerCase();
    const localPart = m[0].split("@")[0].toLowerCase();
    if (SAFE_EMAIL_DOMAINS.includes(domain)) continue;
    if (localPart === "noreply") continue;
    if (localPart === "git" && GIT_HOST_DOMAINS.includes(domain)) continue;
    return m[0];
  }
  return null;
}

function findHomePathLeak(text) {
  // Matches /home/<name>, /Users/<name>, or C:\Users\<name> where <name>
  // isn't one of the known-safe placeholder words this codebase's own
  // tests intentionally use.
  const re = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].toLowerCase();
    if (SAFE_PATH_NAMES.includes(name)) continue;
    return m[0];
  }
  return null;
}

const LITERAL_FORBIDDEN = [
  { needle: "eliskaj", label: "the maintainer's real username" },
  { needle: "elcaj.sp", label: "the maintainer's real email" },
];
// Checked in code/config, but NOT in docs (README.md/SPEC.md) — SPEC.md is
// this product's pre-existing, already-public authoritative design doc and
// legitimately documents what it's derived from; the actual risk this
// guards against is Athena's own CODE depending on or leaking
// Zeona-specific behavior/data, not the project's documented history.
const CODE_ONLY_FORBIDDEN = [{ needle: "zeona", label: "a Zeona-specific name (this product must stand alone)" }];

function scanContent(text, { isDoc }) {
  const violations = [];
  const lower = text.toLowerCase();
  const forbidden = isDoc ? LITERAL_FORBIDDEN : [...LITERAL_FORBIDDEN, ...CODE_ONLY_FORBIDDEN];
  for (const { needle, label } of forbidden) {
    if (lower.includes(needle)) violations.push(`contains ${label} ("${needle}")`);
  }
  const email = findEmailLeak(text);
  if (email) violations.push(`contains what looks like a real email address ("${email}")`);
  const homePath = findHomePathLeak(text);
  if (homePath) violations.push(`contains what looks like a real absolute home-directory path ("${homePath}")`);
  return violations;
}

function isLikelyBinary(buf) {
  return buf.includes(0);
}

function listStagedFiles() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function readFileContent(relPath, staged) {
  if (staged) {
    // Read from the git index (what will actually be committed), not the
    // working tree — a file can be edited again after `git add` without
    // re-staging, and it's the staged *blob* that's about to become part
    // of history.
    return execFileSync("git", ["show", `:${relPath}`], { cwd: REPO_ROOT, encoding: "utf8" });
  }
  return readFileSync(new URL(relPath, `file://${REPO_ROOT}`), "utf8");
}

function main() {
  const staged = process.argv.includes("--staged");
  const files = staged ? listStagedFiles() : listTrackedFiles();

  const structuralViolations = [];
  const contentViolations = [];

  for (const relPath of files) {
    if (!isPathAllowed(relPath)) {
      structuralViolations.push(relPath);
      continue; // not on the allowlist at all — don't bother scanning its content
    }

    // This guard's own source necessarily contains the literal needles it
    // scans for (they're the detection patterns, not leaked data) — scanning
    // itself would be a permanent, meaningless false positive, not a real
    // finding. Everything else still gets scanned normally.
    if (relPath === "scripts/check-privacy.js") continue;

    let raw;
    try {
      raw = staged
        ? execFileSync("git", ["show", `:${relPath}`], { cwd: REPO_ROOT })
        : readFileSync(new URL(relPath, `file://${REPO_ROOT}`));
    } catch {
      continue; // file deleted/renamed away by the time we got here — nothing to scan
    }
    if (isLikelyBinary(raw)) continue;

    const text = raw.toString("utf8");
    const violations = scanContent(text, { isDoc: /\.md$/i.test(relPath) });
    if (violations.length > 0) {
      contentViolations.push({ relPath, violations });
    }
  }

  if (structuralViolations.length === 0 && contentViolations.length === 0) {
    console.log(`check-privacy: clean (${files.length} file(s) checked).`);
    return 0;
  }

  console.error("check-privacy: BLOCKED — possible privacy/data leak.\n");
  if (structuralViolations.length > 0) {
    console.error("Files outside the allowed source/test/doc/config paths:");
    for (const f of structuralViolations) console.error(`  - ${f}`);
    console.error(
      "If this is genuinely a new source/config file, add a pattern for it to\n" +
        "ALLOWED_PATH_PATTERNS in scripts/check-privacy.js. If it's user data,\n" +
        "a log, an upload, or anything generated at runtime, it must never be\n" +
        "committed at all — see SPEC.md section 3.\n",
    );
  }
  if (contentViolations.length > 0) {
    console.error("Files whose content matches a known personal-data pattern:");
    for (const { relPath, violations } of contentViolations) {
      console.error(`  - ${relPath}`);
      for (const v of violations) console.error(`      ${v}`);
    }
    console.error("");
  }
  return 1;
}

process.exit(main());
