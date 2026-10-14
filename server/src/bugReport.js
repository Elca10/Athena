// "Report a bug" (SPEC.md section 10/3.6 — the plain-report-and-file half
// only; no Bug Fixer in v1.0). Flow: the user types a plain-language
// description; this module adds automatic diagnostics (app version/
// commit, OS, recent server error lines), redacts the whole thing
// (redact.js), and hands back the EXACT title/body a preview shows the
// user. Only on an explicit second call (fileBugReportIssue, driven by the
// user's "Send") does anything actually leave the machine, via `gh issue
// create` — body over stdin (`--body-file -`), never a shell string, per
// processUtil.js's own argv-array convention.
//
// Bug report text is untrusted input (SPEC.md section 10) — redactText
// never throws, and buildBugReportPreview only ever reads from the data
// store (subject/topic names, for redaction) and the OS, never anything
// the report's own text could point at.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { runCommand } from "./processUtil.js";
import { redactText } from "./redact.js";
import { getRecentErrorLines } from "./errorLog.js";
import { listSubjects } from "./subjects.js";
import { listTopics } from "./topics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

export const BUG_REPORT_REPO = "Elca10/Athena";
const BUG_REPORT_LABEL = "bug-report";

const TITLE_MAX = 72;

/** Current checkout's commit, best-effort — `null` if `cwd` isn't a git
 * checkout at all (e.g. a test running outside one) rather than throwing,
 * since a missing commit just means "unknown" in the preview, not a
 * reason to fail the whole report. */
export async function getAppVersion(cwd) {
  let commit = null;
  try {
    const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 5_000 });
    if (result.code === 0) commit = result.stdout.trim();
  } catch {
    // Not a git checkout, or git isn't on PATH — leave commit null.
  }
  return { packageVersion: pkg.version, commit };
}

const OS_LABELS = { win32: "Windows", darwin: "macOS", linux: "Linux" };

export function getOsSummary() {
  return {
    platform: process.platform,
    label: OS_LABELS[process.platform] ?? process.platform,
    release: os.release(),
    arch: process.arch,
  };
}

/** Every subject and topic name currently on record, across all subjects
 * (archived included — an archived subject's name is still the user's
 * data) — the list redactText scrubs out of both the description and the
 * diagnostics. */
export async function getKnownNames(appDataDir) {
  const subjects = await listSubjects(appDataDir, { includeArchived: true });
  const topicLists = await Promise.all(subjects.map((s) => listTopics(appDataDir, s.id)));
  return {
    subjectNames: subjects.map((s) => s.name),
    topicNames: topicLists.flat().map((t) => t.name),
  };
}

function buildTitle(redactedDescription) {
  const firstLine = redactedDescription.split("\n")[0].trim() || "no description given";
  const truncated = firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
  return `Bug report: ${truncated}`;
}

function buildBody({ redactedDescription, appVersion, osSummary, redactedErrors }) {
  const versionLine = appVersion.commit ? `${appVersion.packageVersion} (commit ${appVersion.commit.slice(0, 8)})` : `${appVersion.packageVersion} (commit unknown)`;
  const osLine = `${osSummary.label} ${osSummary.release} (${osSummary.arch})`;
  const errorsBlock = redactedErrors.length ? redactedErrors.join("\n") : "None captured.";

  return [
    redactedDescription,
    "",
    "---",
    "**Diagnostics** (collected automatically, redacted before you see this)",
    `- App version: ${versionLine}`,
    `- OS: ${osLine}`,
    "",
    "Recent server errors:",
    "```",
    errorsBlock,
    "```",
  ].join("\n");
}

/**
 * Builds the exact `{title, body}` a preview shows the user — nothing
 * here has any side effect (no network, no `gh` call). `cwd` defaults to
 * this process's own cwd (the repo checkout root when run normally, per
 * installers/bootstrap.mjs's startServerDetached). `appVersion` (a value or
 * promise from getAppVersion) wins when given: the server passes the one it
 * resolved at startup, so the report names the code actually running.
 */
export async function buildBugReportPreview(appDataDir, { description, cwd = process.cwd(), appVersion: startupVersion } = {}) {
  const trimmed = String(description ?? "").trim();
  if (!trimmed) {
    throw new Error("Describe the bug before previewing.");
  }

  const [appVersion, knownNames] = await Promise.all([startupVersion ?? getAppVersion(cwd), getKnownNames(appDataDir)]);
  const osSummary = getOsSummary();
  const recentErrors = getRecentErrorLines();

  const redactOpts = {
    subjectNames: knownNames.subjectNames,
    topicNames: knownNames.topicNames,
    extraLiterals: [os.homedir(), os.userInfo().username],
  };

  const redactedDescription = redactText(trimmed, redactOpts);
  const redactedErrors = recentErrors.map((line) => redactText(line, redactOpts));

  return {
    title: buildTitle(redactedDescription),
    body: buildBody({ redactedDescription, appVersion, osSummary, redactedErrors }),
  };
}

/** Whether the `bug-report` label already exists on the repo — best
 * effort: any failure (gh missing, offline, not authenticated) is treated
 * as "no", since the label is a nice-to-have, never worth blocking or
 * erroring the actual issue filing over. */
export async function checkBugReportLabelExists({ env } = {}) {
  try {
    const result = await runCommand("gh", ["label", "list", "--repo", BUG_REPORT_REPO, "--search", BUG_REPORT_LABEL, "--json", "name"], {
      timeoutMs: 10_000,
      env,
    });
    if (result.code !== 0) return false;
    const parsed = JSON.parse(result.stdout || "[]");
    return Array.isArray(parsed) && parsed.some((l) => l?.name === BUG_REPORT_LABEL);
  } catch {
    return false;
  }
}

const ISSUE_URL_RE = /https:\/\/github\.com\/\S+\/issues\/\d+/;

/** Pure interpretation of `gh issue create`'s result into a plain-language
 * outcome — factored out for the same testability reason as
 * setupChecks.js's `interpretGhAuthStatus`. */
export function interpretGhIssueCreateResult({ code, stdout, stderr }) {
  if (code === 0) {
    const match = stdout.match(ISSUE_URL_RE);
    if (match) return { ok: true, url: match[0] };
    return { ok: false, error: "gh reported success, but no issue URL was found in its output." };
  }

  const combined = `${stdout}\n${stderr}`;
  if (/not logged into any github hosts|gh auth login/i.test(combined)) {
    return { ok: false, error: "Not signed in to GitHub. Run `gh auth login`, then try again." };
  }
  if (/could not resolve host|network is unreachable|timed out|ETIMEDOUT|ENOTFOUND|temporary failure in name resolution|dial tcp|no such host|connection refused/i.test(combined)) {
    return { ok: false, error: "Couldn't reach GitHub — check your internet connection and try again." };
  }
  return { ok: false, error: `GitHub CLI reported an error: ${combined.trim().slice(0, 300) || `exit code ${code}`}` };
}

/**
 * Files the issue for real — the one function in this module with a side
 * effect. `title`/`body` must be exactly what the user previewed and sent
 * (the route layer enforces that; this function just files what it's
 * given). `env` is the same test seam every CLI-wrapping function in this
 * repo uses (setupChecks.js's checkGh, topicExtraction.js's
 * runExtractionTurn) — defaults to the real inherited environment.
 */
export async function fileBugReportIssue({ title, body }, { env } = {}) {
  const labelExists = await checkBugReportLabelExists({ env });
  const args = ["issue", "create", "--repo", BUG_REPORT_REPO, "--title", title, "--body-file", "-"];
  if (labelExists) args.push("--label", BUG_REPORT_LABEL);

  let result;
  try {
    result = await runCommand("gh", args, { timeoutMs: 20_000, env, input: body });
  } catch (err) {
    if (err.notFound) return { ok: false, error: "GitHub CLI (`gh`) isn't installed." };
    return { ok: false, error: `Couldn't run the GitHub CLI: ${err.message}` };
  }
  return interpretGhIssueCreateResult(result);
}
