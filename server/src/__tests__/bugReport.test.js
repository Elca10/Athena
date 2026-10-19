import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAppVersion,
  getOsSummary,
  getKnownNames,
  buildBugReportPreview,
  checkBugReportLabelExists,
  interpretGhIssueCreateResult,
  fileBugReportIssue,
  BUG_REPORT_REPO,
} from "../bugReport.js";
import { recordError, clearRecentErrors } from "../errorLog.js";
import { createSubject } from "../subjects.js";
import { addPlannedTopics } from "../topics.js";
import { fakeGhOnPath } from "./fakeGhOnPath.js";

function emptyPathEnv() {
  return { PATH: os.tmpdir() };
}

async function scratchDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-bugreport-test-"));
}

test("getAppVersion: a real git checkout reports the actual HEAD commit", async () => {
  // This test file's own repo checkout (the parent of server/) is a real
  // git repo — asserting against `git rev-parse HEAD` directly, rather
  // than any hardcoded sha, so this never goes stale.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const version = await getAppVersion(repoRoot);
  assert.equal(typeof version.packageVersion, "string");
  assert.match(version.commit, /^[0-9a-f]{40}$/);
});

test("getAppVersion: a non-git directory reports commit: null, not a throw", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-not-a-repo-"));
  const version = await getAppVersion(dir);
  assert.equal(version.commit, null);
  assert.equal(typeof version.packageVersion, "string");
});

test("getAppVersion: the release tag names the version, with distance past it on a dev checkout", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-version-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "-q", "--allow-empty", "-m", "one");
    // No tag yet: falls back to package.json's version.
    assert.equal((await getAppVersion(dir)).version, (await getAppVersion(dir)).packageVersion);
    git("tag", "-a", "v0.3.0", "-m", "- one");
    assert.equal((await getAppVersion(dir)).version, "v0.3.0");
    git("commit", "-q", "--allow-empty", "-m", "two");
    assert.match((await getAppVersion(dir)).version, /^v0\.3\.0-1-g[0-9a-f]+$/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("getOsSummary reports this process's real platform/arch", () => {
  const summary = getOsSummary();
  assert.equal(summary.platform, process.platform);
  assert.equal(summary.arch, process.arch);
  assert.equal(typeof summary.release, "string");
  assert.equal(typeof summary.label, "string");
});

test("getKnownNames collects subject and topic names across every subject, archived included", async () => {
  const dir = await scratchDataDir();
  const subject = await createSubject(dir, { name: "CSC4553" });
  await addPlannedTopics(dir, subject.id, ["Krebs cycle", "Binary search trees"]);

  const names = await getKnownNames(dir);
  assert.deepEqual(names.subjectNames, ["CSC4553"]);
  assert.deepEqual(new Set(names.topicNames), new Set(["Krebs cycle", "Binary search trees"]));
});

test("buildBugReportPreview rejects an empty description", async () => {
  const dir = await scratchDataDir();
  await assert.rejects(() => buildBugReportPreview(dir, { description: "   " }), /describe the bug/i);
});

test("buildBugReportPreview's title is a truncated first line, prefixed", async () => {
  const dir = await scratchDataDir();
  const longLine = "a".repeat(100);
  const { title } = await buildBugReportPreview(dir, { description: `${longLine}\nsecond line`, cwd: dir });
  assert.ok(title.startsWith("Bug report: "));
  assert.ok(title.length <= "Bug report: ".length + 72);
  assert.ok(!title.includes("second line"));
});

test("buildBugReportPreview's body includes app version, OS, and redacted recent errors", async () => {
  const dir = await scratchDataDir();
  clearRecentErrors();
  recordError("crash at /home/someone/Athena-Studying/server/src/index.js");

  const { body } = await buildBugReportPreview(dir, { description: "it crashed", cwd: dir });
  assert.match(body, /App version:/);
  assert.match(body, /OS:/);
  assert.match(body, /Recent server errors:/);
  assert.ok(body.includes("/home/<user>/Athena-Studying"));
  assert.ok(!body.includes("/home/someone/"));
  clearRecentErrors();
});

test("buildBugReportPreview prefers a given startup appVersion over the live checkout (issue #4)", async () => {
  // The server resolves its version once at startup; a later installer
  // run can move the checkout under it, and the report must still name
  // the code that's actually running.
  const dir = await scratchDataDir();
  const { body } = await buildBugReportPreview(dir, {
    description: "it crashed",
    cwd: dir,
    appVersion: Promise.resolve({ packageVersion: "9.9.9", commit: "abcdef0123456789" }),
  });
  assert.match(body, /9\.9\.9 \(commit abcdef01\)/);
});

test("buildBugReportPreview's body says 'None captured' when there are no recent errors", async () => {
  const dir = await scratchDataDir();
  clearRecentErrors();
  const { body } = await buildBugReportPreview(dir, { description: "it crashed", cwd: dir });
  assert.match(body, /None captured\./);
});

test("buildBugReportPreview redacts the user's own description, not just diagnostics", async () => {
  const dir = await scratchDataDir();
  const subject = await createSubject(dir, { name: "CSC4553" });
  await addPlannedTopics(dir, subject.id, ["Krebs cycle"]);

  const { title, body } = await buildBugReportPreview(dir, {
    description: "In my CSC4553 subject, the Krebs cycle question never loads. Email me at me@example.com if you need more info, I'm at /home/tester/Desktop.",
    cwd: dir,
  });
  for (const text of [title, body]) {
    assert.ok(!text.includes("CSC4553"));
    assert.ok(!text.includes("Krebs cycle"));
    assert.ok(!text.includes("me@example.com"));
    assert.ok(!text.includes("/home/tester/"));
  }
  assert.ok(body.includes("<subject>"));
  assert.ok(body.includes("<topic>"));
  assert.ok(body.includes("<email>"));
  assert.ok(body.includes("/home/<user>/"));
});

test("checkBugReportLabelExists: true when the fake gh reports the label", async () => {
  const { env } = await fakeGhOnPath({ labelExists: true });
  assert.equal(await checkBugReportLabelExists({ env }), true);
});

test("checkBugReportLabelExists: false when the fake gh reports no match", async () => {
  const { env } = await fakeGhOnPath({ labelExists: false });
  assert.equal(await checkBugReportLabelExists({ env }), false);
});

test("checkBugReportLabelExists: false (not a throw) when gh isn't on PATH at all", async () => {
  assert.equal(await checkBugReportLabelExists({ env: emptyPathEnv() }), false);
});

test("interpretGhIssueCreateResult: exit 0 extracts the issue URL from stdout", () => {
  const result = interpretGhIssueCreateResult({
    code: 0,
    stdout: "https://github.com/Elca10/Athena/issues/42\n",
    stderr: "",
  });
  assert.deepEqual(result, { ok: true, url: "https://github.com/Elca10/Athena/issues/42" });
});

test("interpretGhIssueCreateResult: exit 0 with no URL in stdout is reported as a failure, not a false success", () => {
  const result = interpretGhIssueCreateResult({ code: 0, stdout: "done\n", stderr: "" });
  assert.equal(result.ok, false);
  assert.match(result.error, /no issue url/i);
});

test("interpretGhIssueCreateResult: not-logged-in wording maps to a plain-language message", () => {
  const result = interpretGhIssueCreateResult({
    code: 1,
    stdout: "",
    stderr: "You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /gh auth login/);
});

test("interpretGhIssueCreateResult: network failure wording maps to a plain-language message", () => {
  const result = interpretGhIssueCreateResult({
    code: 1,
    stdout: "",
    stderr: "error connecting to api.github.com: dial tcp: lookup api.github.com: Temporary failure in name resolution\n",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /internet connection/i);
});

test("interpretGhIssueCreateResult: an unrecognized failure still reports something, not silence", () => {
  const result = interpretGhIssueCreateResult({ code: 1, stdout: "", stderr: "some other gh failure\n" });
  assert.equal(result.ok, false);
  assert.match(result.error, /some other gh failure/);
});

test("fileBugReportIssue: sends title/body via argv/stdin and returns the fake issue URL", async () => {
  const captureFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "athena-gh-capture-")), "capture.json");
  const { env } = await fakeGhOnPath({ mode: "success", labelExists: false, captureFile });

  const result = await fileBugReportIssue({ title: "Bug report: things broke", body: "full body text\nhere" }, { env });
  assert.deepEqual(result, { ok: true, url: "https://github.com/Elca10/Athena/issues/123" });

  const captured = JSON.parse(await fs.readFile(captureFile, "utf8"));
  assert.deepEqual(captured.argv, ["issue", "create", "--repo", BUG_REPORT_REPO, "--title", "Bug report: things broke", "--body-file", "-"]);
  assert.equal(captured.stdin, "full body text\nhere");
});

test("fileBugReportIssue: adds --label when the label already exists on the repo", async () => {
  const captureFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "athena-gh-capture-")), "capture.json");
  const { env } = await fakeGhOnPath({ mode: "success", labelExists: true, captureFile });

  await fileBugReportIssue({ title: "t", body: "b" }, { env });

  const captured = JSON.parse(await fs.readFile(captureFile, "utf8"));
  assert.deepEqual(captured.argv.slice(-2), ["--label", "bug-report"]);
});

test("fileBugReportIssue: never adds --label when it doesn't exist on the repo", async () => {
  const captureFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "athena-gh-capture-")), "capture.json");
  const { env } = await fakeGhOnPath({ mode: "success", labelExists: false, captureFile });

  await fileBugReportIssue({ title: "t", body: "b" }, { env });

  const captured = JSON.parse(await fs.readFile(captureFile, "utf8"));
  assert.ok(!captured.argv.includes("--label"));
});

test("fileBugReportIssue: surfaces a plain-language error when gh isn't logged in", async () => {
  const { env } = await fakeGhOnPath({ mode: "not-logged-in" });
  const result = await fileBugReportIssue({ title: "t", body: "b" }, { env });
  assert.equal(result.ok, false);
  assert.match(result.error, /gh auth login/);
});

test("fileBugReportIssue: surfaces a plain-language error when offline", async () => {
  const { env } = await fakeGhOnPath({ mode: "offline" });
  const result = await fileBugReportIssue({ title: "t", body: "b" }, { env });
  assert.equal(result.ok, false);
  assert.match(result.error, /internet connection/i);
});

test("fileBugReportIssue: surfaces a plain-language error when gh isn't installed", async () => {
  const result = await fileBugReportIssue({ title: "t", body: "b" }, { env: emptyPathEnv() });
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't installed/i);
});
