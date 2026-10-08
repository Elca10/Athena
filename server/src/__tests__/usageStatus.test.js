import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseResetsAt,
  parseUsageCommandText,
  runUsageCheckTurn,
  checkUsageNow,
  getCachedUsageStatus,
} from "../usageStatus.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-usage-status-"));
}

// An env whose PATH points nowhere real -- same technique setupChecks.test.js
// and topicExtraction.test.js already use to make "claude not found"
// deterministic regardless of whether the real CLI happens to be installed
// on the machine running this test.
function emptyPathEnv() {
  return { PATH: os.tmpdir() };
}

// --- parseResetsAt -----------------------------------------------------------

test("parseResetsAt: 'Aug 24 at 5pm' (no minutes) resolves using the given year/local time", () => {
  const now = new Date(2026, 7, 24, 16, 14, 0).getTime();
  const resetsAt = parseResetsAt("Aug 24 at 5pm", now);
  assert.equal(resetsAt, Math.floor(new Date(2026, 7, 24, 17, 0, 0).getTime() / 1000));
});

test("parseResetsAt: handles minutes and am/pm hour math ('Aug 24 at 9:59pm' -> 21:59, not 9:59)", () => {
  const now = new Date(2026, 7, 24, 17, 1, 0).getTime();
  const resetsAt = parseResetsAt("Aug 24 at 9:59pm", now);
  assert.equal(resetsAt, Math.floor(new Date(2026, 7, 24, 21, 59, 0).getTime() / 1000));
});

test("parseResetsAt: 12am is hour 0, not hour 12 ('Aug 30 at 12:59am')", () => {
  const now = new Date(2026, 7, 24, 17, 1, 0).getTime();
  const resetsAt = parseResetsAt("Aug 30 at 12:59am", now);
  assert.equal(resetsAt, Math.floor(new Date(2026, 7, 30, 0, 59, 0).getTime() / 1000));
});

test("parseResetsAt: rolls over to next year when the current year's date would already be well in the past", () => {
  const now = new Date(2026, 11, 31, 23, 0, 0).getTime(); // Dec 31, 2026
  const resetsAt = parseResetsAt("Jan 2 at 3am", now);
  assert.equal(resetsAt, Math.floor(new Date(2027, 0, 2, 3, 0, 0).getTime() / 1000));
});

test("parseResetsAt: the CLI's comma form ('Oct 4, 12:59am') parses the same as the 'at' form", () => {
  const now = new Date(2026, 9, 3, 1, 49).getTime();
  assert.equal(parseResetsAt("Oct 4, 12:59am", now), parseResetsAt("Oct 4 at 12:59am", now));
  assert.equal(parseResetsAt("Oct 4, 12:59am", now), Math.floor(new Date(2026, 9, 4, 0, 59).getTime() / 1000));
});

test("parseResetsAt: undefined (not throwing) on text that doesn't match the expected shape", () => {
  assert.equal(parseResetsAt("sometime soon"), undefined);
});

// --- parseUsageCommandText ----------------------------------------------------
// Fixtures below are real `/usage` reply shapes (ported from a comparable
// integration's own live-captured examples), not invented ones.

test("parseUsageCommandText: parses a real captured /usage reply into both windows", () => {
  const now = new Date(2026, 7, 24, 16, 14, 0).getTime();
  const text =
    "You are currently using your subscription to power your Claude Code usage\n\n" +
    "Current session: 27% used · resets Aug 24 at 5pm (America/Los_Angeles)\n" +
    "Current week (all models): 19% used · resets Aug 30 at 1am (America/Los_Angeles)\n\n" +
    "What's contributing to your limits usage?\n...";
  const dual = parseUsageCommandText(text, now);
  assert.deepEqual(dual.fiveHour, {
    status: "ok",
    utilization: 0.27,
    resetsAt: Math.floor(new Date(2026, 7, 24, 17, 0, 0).getTime() / 1000),
  });
  assert.deepEqual(dual.weekly, {
    status: "ok",
    utilization: 0.19,
    resetsAt: Math.floor(new Date(2026, 7, 30, 1, 0, 0).getTime() / 1000),
  });
});

test("parseUsageCommandText: keeps resetsAt for both windows in the CLI's reworded comma reply", () => {
  const now = new Date(2026, 9, 3, 1, 49).getTime();
  const text =
    "You are currently using your subscription to power your Claude Code usage\n\n" +
    "Current session: 44% used · resets Oct 3, 5:29am (America/Tijuana)\n" +
    "Current week (all models): 21% used · resets Oct 4, 12:59am (America/Tijuana)\n";
  const { fiveHour, weekly } = parseUsageCommandText(text, now);
  assert.equal(fiveHour.resetsAt, Math.floor(new Date(2026, 9, 3, 5, 29).getTime() / 1000));
  assert.equal(weekly.resetsAt, Math.floor(new Date(2026, 9, 4, 0, 59).getTime() / 1000));
});

test("parseUsageCommandText: derives warning/exceeded status from the percentage -- the reply carries no status word at all", () => {
  const text =
    "Current session: 100% used · resets Aug 24 at 5pm (America/Los_Angeles)\n" +
    "Current week (all models): 92% used · resets Aug 30 at 1am (America/Los_Angeles)\n";
  const dual = parseUsageCommandText(text);
  assert.equal(dual.fiveHour.status, "exceeded");
  assert.equal(dual.weekly.status, "warning");
});

test("parseUsageCommandText: {fiveHour: null, weekly: null} on an unrecognized reply shape, instead of throwing", () => {
  const dual = parseUsageCommandText("/usage isn't available in this environment.");
  assert.deepEqual(dual, { fiveHour: null, weekly: null });
});

test("parseUsageCommandText: only matches the all-models weekly line, not a per-model 'Current week (Opus)' line", () => {
  const text =
    "Current session: 10% used · resets Aug 24 at 5pm (America/Los_Angeles)\n" +
    "Current week (Opus): 80% used · resets Aug 30 at 1am (America/Los_Angeles)\n";
  const dual = parseUsageCommandText(text);
  assert.equal(dual.fiveHour.utilization, 0.1);
  assert.equal(dual.weekly, null, "a per-model line must not be mistaken for the all-models one");
});

// --- runUsageCheckTurn --------------------------------------------------------

test("runUsageCheckTurn rejects with a clear error when the claude CLI can't be found", async () => {
  await assert.rejects(() => runUsageCheckTurn({ env: emptyPathEnv() }), (err) => {
    assert.ok(err.notFound || /ENOENT/.test(err.message));
    return true;
  });
});

// --- checkUsageNow / getCachedUsageStatus (the orchestration) ----------------

test("checkUsageNow records a successful reading and getCachedUsageStatus serves it back", async () => {
  const dir = await scratchDir();
  const runTurn = async () =>
    "Current session: 12% used · resets Aug 24 at 5pm (America/Los_Angeles)\n" +
    "Current week (all models): 20% used · resets Aug 30 at 12:59am (America/Los_Angeles)\n";
  const result = await checkUsageNow(dir, { runTurn });
  assert.equal(result.error, null);
  assert.equal(result.fiveHour.utilization, 0.12);
  assert.equal(result.weekly.utilization, 0.2);
  assert.equal(typeof result.checkedAt, "number");

  const cached = await getCachedUsageStatus(dir);
  assert.deepEqual(cached, result);
});

test("checkUsageNow records a null/null + error reading when the turn throws, rather than leaving the cache untouched silently", async () => {
  const dir = await scratchDir();
  const runTurn = async () => {
    throw new Error("claude exited with code 1: not logged in");
  };
  const result = await checkUsageNow(dir, { runTurn });
  assert.equal(result.fiveHour, null);
  assert.equal(result.weekly, null);
  assert.match(result.error, /not logged in/);

  const cached = await getCachedUsageStatus(dir);
  assert.deepEqual(cached, result);
});

test("checkUsageNow records an error when the reply can't be parsed at all, instead of throwing", async () => {
  const dir = await scratchDir();
  const runTurn = async () => "/usage isn't available in this environment.";
  const result = await checkUsageNow(dir, { runTurn });
  assert.equal(result.fiveHour, null);
  assert.equal(result.weekly, null);
  assert.match(result.error, /couldn't parse/i);
});

test("getCachedUsageStatus returns the default shape for a fresh app-data dir", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await getCachedUsageStatus(dir), { fiveHour: null, weekly: null, checkedAt: null, error: null });
});
