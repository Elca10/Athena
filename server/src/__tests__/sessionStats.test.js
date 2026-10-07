import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubject } from "../subjects.js";
import { createSession, setCurrentQuestion, recordAnswer, archiveSession } from "../sessions.js";
import { appDataSubdirs } from "../dataDir.js";
import { makeJsonFileStore } from "../store/jsonFileStore.js";
import { computeStreakDays, computeAccuracy, computeCalibration, getSessionStats } from "../sessionStats.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-session-stats-"));
}

// createSession always stamps `startedAt` with the real current time, with
// no override param (matching every other record's creation-time stamping
// in this codebase) — so backdating a session for a "this week" boundary
// test has to go around it, straight through the same store it uses.
async function backdateSessionStartedAt(dir, sessionId, startedAt) {
  const store = makeJsonFileStore(appDataSubdirs(dir).db, "sessions.json", []);
  await store.update((sessions) => sessions.map((s) => (s.id === sessionId ? { ...s, startedAt } : s)));
}

function fakeAnswered({ answeredAt, rating, confidence }) {
  return { topicId: "t1", prompt: "p", answeredAt, rating, confidence };
}

function fakeSession({ startedAt = new Date().toISOString(), history = [], archived = false } = {}) {
  return { startedAt, history, archived };
}

test("computeStreakDays counts consecutive answered days backward from now, breaking on a gap", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const sessions = [
    fakeSession({
      history: [
        fakeAnswered({ answeredAt: "2026-10-10T08:00:00.000Z", rating: "good", confidence: 3 }),
        fakeAnswered({ answeredAt: "2026-10-09T08:00:00.000Z", rating: "good", confidence: 3 }),
        fakeAnswered({ answeredAt: "2026-10-08T08:00:00.000Z", rating: "good", confidence: 3 }),
        // gap on the 7th
        fakeAnswered({ answeredAt: "2026-10-06T08:00:00.000Z", rating: "good", confidence: 3 }),
      ],
    }),
  ];
  assert.equal(computeStreakDays(sessions, now), 3);
});

test("computeStreakDays is 0 when nothing was answered today", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const sessions = [
    fakeSession({ history: [fakeAnswered({ answeredAt: "2026-10-09T08:00:00.000Z", rating: "good", confidence: 3 })] }),
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

test("getSessionStats counts sessions/questions within the last 7 days and excludes older ones", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "History" });
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const recent = await createSession(dir, { subjectIds: [subject.id], mode: "live", topicIds: ["t1"] });
  await setCurrentQuestion(dir, recent.id, { topicId: "t1", prompt: "p" });
  await recordAnswer(dir, recent.id, {
    topicId: "t1",
    prompt: "p",
    rating: "good",
    confidence: 4,
    answeredAt: oneDayAgo,
  });

  const old = await createSession(dir, { subjectIds: [subject.id], mode: "live", topicIds: ["t1"] });
  await backdateSessionStartedAt(dir, old.id, thirtyDaysAgo);
  await setCurrentQuestion(dir, old.id, { topicId: "t1", prompt: "p" });
  await recordAnswer(dir, old.id, {
    topicId: "t1",
    prompt: "p",
    rating: "again",
    confidence: 2,
    answeredAt: thirtyDaysAgo,
  });
  const stats = await getSessionStats(dir, now);
  assert.equal(stats.sessionsThisWeek, 1);
  assert.equal(stats.questionsThisWeek, 1);
  assert.equal(stats.accuracy.total, 2);
  assert.equal(stats.accuracy.correct, 1);
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
