// Top-bar session stats (SPEC.md section 4: "session stats (sessions/
// questions this week, streak, accuracy, calibration)"). Pure aggregation
// over sessions.js's existing data — no storage of its own, same posture
// as subjectSummary.js.
//
// "This week" is a rolling 7-day window ending now (not a calendar week) —
// simpler than reasoning about week-start day or the user's timezone, and
// consistent with how the scheduler already treats "due" as relative to
// `now` rather than a calendar boundary (Ada's call, section 11-style).
// Accuracy and calibration are deliberately all-time, not weekly: section
// 6 describes calibration as "predicted vs actual accuracy over time",
// and a 7-day accuracy figure would be noisy at the small session counts
// this app expects.

import { listSessions } from "./sessions.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// "good"/"easy" mean the answer was right or solid; "again"/"hard" mean it
// wasn't there yet. This holds across Live's model-graded rating and
// Ready's auto-graded/self-graded ratings alike, since both paths always
// resolve to one of scheduler.js's four FSRS ratings before an answer is
// recorded (liveSession.js, readySession.js) — so accuracy/calibration can
// read `rating` alone without caring which mode or grading path produced it.
function isCorrectRating(rating) {
  return rating === "good" || rating === "easy";
}

function allAnsweredQuestions(sessions) {
  return sessions.flatMap((s) => s.history ?? []);
}

function dayKey(isoString) {
  return isoString.slice(0, 10); // YYYY-MM-DD, UTC
}

/**
 * Longest-running streak of consecutive days (including today) with at
 * least one answered question, counting backward from `now`. A day with
 * zero answered questions anywhere in it breaks the streak. Day boundaries
 * are UTC calendar days (server has no reliable user timezone) — a rough
 * edge at midnight is an acceptable tradeoff for a stat this informal.
 */
export function computeStreakDays(sessions, now = new Date()) {
  const answeredDays = new Set(allAnsweredQuestions(sessions).map((q) => dayKey(q.answeredAt)).filter(Boolean));
  let streak = 0;
  const cursor = new Date(now);
  while (answeredDays.has(dayKey(cursor.toISOString()))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

/**
 * Accuracy across every answered question, all-time: how many were rated
 * "good"/"easy" vs. "again"/"hard". `rate` is null (not 0) when nothing has
 * been answered yet, so the UI can distinguish "no data" from "0% so far".
 */
export function computeAccuracy(sessions) {
  const questions = allAnsweredQuestions(sessions);
  const correct = questions.filter((q) => isCorrectRating(q.rating)).length;
  return { correct, total: questions.length, rate: questions.length === 0 ? null : correct / questions.length };
}

/**
 * Predicted (confidence 1-5) vs actual accuracy, bucketed by confidence
 * level (Hermione's `hermione_calibration.json` model, per section 6 —
 * ported as a live bucketing over existing history rather than its own
 * telemetry log, since every answered question here already carries both
 * `confidence` and `rating`). Good calibration means the correctRate rises
 * with confidence; levels with no data get `correctRate: null`, not 0.
 */
export function computeCalibration(sessions) {
  const questions = allAnsweredQuestions(sessions);
  const byConfidence = [1, 2, 3, 4, 5].map((confidence) => {
    const atLevel = questions.filter((q) => q.confidence === confidence);
    const correct = atLevel.filter((q) => isCorrectRating(q.rating)).length;
    return { confidence, total: atLevel.length, correctRate: atLevel.length === 0 ? null : correct / atLevel.length };
  });
  return { byConfidence };
}

export async function getSessionStats(appDataDir, now = new Date()) {
  // Archiving a session only hides it from the dashboard (SPEC.md section
  // 4) — it shouldn't also erase it from stats that are about historical
  // activity, so this reads every session, archived or not.
  const sessions = await listSessions(appDataDir, { includeArchived: true });
  const weekStart = new Date(now.getTime() - WEEK_MS);

  const sessionsThisWeek = sessions.filter((s) => new Date(s.startedAt) >= weekStart).length;
  const questionsThisWeek = allAnsweredQuestions(sessions).filter((q) => {
    const answeredAt = q.answeredAt ? new Date(q.answeredAt) : null;
    return answeredAt && answeredAt >= weekStart && answeredAt <= now;
  }).length;

  return {
    sessionsThisWeek,
    questionsThisWeek,
    streakDays: computeStreakDays(sessions, now),
    accuracy: computeAccuracy(sessions),
    calibration: computeCalibration(sessions),
  };
}
