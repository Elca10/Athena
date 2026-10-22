import { test } from "node:test";
import assert from "node:assert/strict";
import { createSubject } from "../subjects.js";
import { createSession, setCurrentQuestion, recordAnswer, archiveSession } from "../sessions.js";
import { appDataSubdirs } from "../dataDir.js";
import { makeJsonFileStore } from "../store/jsonFileStore.js";
import { computeStreakDays, computeAccuracy, computeCalibration, getSessionStats } from "../sessionStats.js";
import { makeTempDir } from "../testHelpers/tempDir.js";

async function scratchDir() {
  return makeTempDir("athena-session-stats-");
}

// createSession always stamps `startedAt` with the real current time, with
// no override param (matching every other record's creation-time stamping
// in this codebase) — so backdating a session for a "this week" boundary
// test has to go around it, straight through the same store it uses.
async function backdateSessionStartedAt(dir, sessionId, startedAt) {
  const store = makeJsonFileStore(appDataSubdirs(dir).db, "sessions.json", []);
  await store.update((sessions) => sessions.map((s) => (s.id === sessionId ? { ...s, startedAt } : s)));
}

// Local wall-clock times (month is 1-based here), so day/week boundaries
// land where a user in any zone would see them.
function local(y, mo, d, h = 12, mi = 0) {
  return new Date(y, mo - 1, d, h, mi);
}
function localIso(...args) {
  return local(...args).toISOString();
}

function fakeAnswered({ answeredAt, rating, confidence }) {
  return { topicId: "t1", prompt: "p", answeredAt, rating, confidence };
}

function fakeSession({ startedAt = new Date().toISOString(), history = [], archived = false } = {}) {
  return { startedAt, history, archived };
}

test("computeStreakDays counts consecutive answered days backward from now, breaking on a gap", () => {
  const now = local(2026, 10, 10, 12);
  const sessions = [
    fakeSession({
      history: [
        fakeAnswered({ answeredAt: localIso(2026, 10, 10, 8), rating: "good", confidence: 3 }),
        fakeAnswered({ answeredAt: localIso(2026, 10, 9, 8), rating: "good", confidence: 3 }),
        fakeAnswered({ answeredAt: localIso(2026, 10, 8, 8), rating: "good", confidence: 3 }),
        // gap on the 7th
        fakeAnswered({ answeredAt: localIso(2026, 10, 6, 8), rating: "good", confidence: 3 }),
      ],
    }),
  ];
  assert.equal(computeStreakDays(sessions, now), 3);
});

test("computeStreakDays is 0 when nothing was answered today", () => {
  const now = local(2026, 10, 10, 12);
  const sessions = [
    fakeSession({ history: [fakeAnswered({ answeredAt: localIso(2026, 10, 9, 8), rating: "good", confidence: 3 })] }),
  ];
  assert.equal(computeStreakDays(sessions, now), 0);
});

test("computeStreakDays is 0 with no answered questions at all", () => {
  assert.equal(computeStreakDays([fakeSession()], new Date()), 0);
});

test("computeAccuracy treats good/easy as correct and again/hard as not, across sessions", () => {
  const sessions = [
    fakeSession({
      history: [
        fakeAnswered({ answeredAt: "2026-10-10T08:00:00.000Z", rating: "good", confidence: 3 }),
        fakeAnswered({ answeredAt: "2026-10-10T08:05:00.000Z", rating: "easy", confidence: 5 }),
      ],
    }),
    fakeSession({
      history: [
        fakeAnswered({ answeredAt: "2026-10-10T08:10:00.000Z", rating: "again", confidence: 1 }),
        fakeAnswered({ answeredAt: "2026-10-10T08:15:00.000Z", rating: "hard", confidence: 2 }),
      ],
    }),
  ];
  assert.deepEqual(computeAccuracy(sessions), { correct: 2, total: 4, rate: 0.5 });
});

test("computeAccuracy returns a null rate (not 0) when nothing has been answered", () => {
  assert.deepEqual(computeAccuracy([fakeSession()]), { correct: 0, total: 0, rate: null });
});

test("computeCalibration buckets correctRate by confidence level, null for untouched levels", () => {
  const sessions = [
    fakeSession({
      history: [
        fakeAnswered({ answeredAt: "2026-10-10T08:00:00.000Z", rating: "good", confidence: 5 }),
        fakeAnswered({ answeredAt: "2026-10-10T08:05:00.000Z", rating: "again", confidence: 1 }),
        fakeAnswered({ answeredAt: "2026-10-10T08:10:00.000Z", rating: "hard", confidence: 1 }),
      ],
    }),
  ];
  const { byConfidence } = computeCalibration(sessions);
  assert.deepEqual(
    byConfidence.map((b) => [b.confidence, b.total, b.correctRate]),
    [
      [1, 2, 0],
      [2, 0, null],
      [3, 0, null],
      [4, 0, null],
      [5, 1, 1],
    ],
  );
});

async function addAnsweredSession(dir, subjectId, at, rating) {
  const session = await createSession(dir, { subjectIds: [subjectId], mode: "live", topicIds: ["t1"] });
  await backdateSessionStartedAt(dir, session.id, at);
  await setCurrentQuestion(dir, session.id, { topicId: "t1", prompt: "p" });
  await recordAnswer(dir, session.id, { topicId: "t1", prompt: "p", rating, confidence: 3, answeredAt: at });
}

test("getSessionStats counts this calendar week (Monday on), not a rolling 7 days (issue #12)", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "History" });
  // Wednesday 2026-10-21. Last Sunday night is under 7 days ago but last week.
  const now = local(2026, 10, 21, 12);
  await addAnsweredSession(dir, subject.id, localIso(2026, 10, 19, 0, 30), "good"); // Monday, just after midnight
  await addAnsweredSession(dir, subject.id, localIso(2026, 10, 18, 23, 30), "again"); // Sunday, last week
  await addAnsweredSession(dir, subject.id, localIso(2026, 9, 21), "again"); // a month ago

  const stats = await getSessionStats(dir, now);
  assert.equal(stats.sessionsThisWeek, 1);
  assert.equal(stats.questionsThisWeek, 1);
  assert.equal(stats.accuracy.total, 3);
  assert.equal(stats.accuracy.correct, 1);
});

test("getSessionStats shows an empty week on Monday after studying only last week", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "History" });
  await addAnsweredSession(dir, subject.id, localIso(2026, 10, 14), "good"); // the previous Wednesday
  const stats = await getSessionStats(dir, local(2026, 10, 19, 9)); // Monday
  assert.equal(stats.sessionsThisWeek, 0);
  assert.equal(stats.questionsThisWeek, 0);
});

test("computeStreakDays counts local days, so a late-evening answer stays on its own day", () => {
  const sessions = [
    fakeSession({
      history: [
        fakeAnswered({ answeredAt: localIso(2026, 10, 10, 23, 30), rating: "good", confidence: 3 }),
        fakeAnswered({ answeredAt: localIso(2026, 10, 9, 23, 30), rating: "good", confidence: 3 }),
      ],
    }),
  ];
  assert.equal(computeStreakDays(sessions, local(2026, 10, 10, 23, 45)), 2);
  assert.equal(computeStreakDays(sessions, local(2026, 10, 11, 0, 15)), 0);
});

test("getSessionStats includes archived sessions' history in all-time accuracy/calibration", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "Bio" });
  const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: ["t1"] });
  await setCurrentQuestion(dir, session.id, { topicId: "t1", prompt: "p" });
  await recordAnswer(dir, session.id, {
    topicId: "t1",
    prompt: "p",
    rating: "good",
    confidence: 3,
    answeredAt: new Date().toISOString(),
  });
  await archiveSession(dir, session.id);

  const stats = await getSessionStats(dir, new Date());
  assert.equal(stats.accuracy.total, 1);
  assert.equal(stats.accuracy.correct, 1);
});
