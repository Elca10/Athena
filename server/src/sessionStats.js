// Top-bar session stats (SPEC.md section 4: "session stats (sessions/
// questions this week, streak, accuracy, calibration)"). Pure aggregation
// over sessions.js's existing data — no storage of its own, same posture
// as subjectSummary.js.
//
// "This week" is the current local calendar week, Monday to Sunday (the
// Calendar's own week order). It used to be a rolling 7-day window, which
// kept showing last week's activity as "this week" for days after Monday
// (issue #12). Days are the user's local days (localDate.js): Athena runs
// on the user's machine, so the server's zone is theirs.
// Accuracy and calibration are deliberately all-time, not weekly: section
// 6 describes calibration as "predicted vs actual accuracy over time",
// and a 7-day accuracy figure would be noisy at the small session counts
// this app expects.

import { addDays, localDateOf, startOfWeek } from "./localDate.js";
import { listSessions } from "./sessions.js";

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

/**
 * Longest-running streak of consecutive local days (including today) with
 * at least one answered question, counting backward from `now`. A day with
 * zero answered questions anywhere in it breaks the streak.
 */
export function computeStreakDays(sessions, now = new Date()) {
  const answeredDays = new Set(
    allAnsweredQuestions(sessions)
      .filter((q) => q.answeredAt)
      .map((q) => localDateOf(q.answeredAt)),
  );
  let streak = 0;
  let day = localDateOf(now);
  while (answeredDays.has(day)) {
    streak += 1;
    day = addDays(day, -1);
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
 * level (the original tool's calibration model, per section 6 —
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
  // YYYY-MM-DD strings compare correctly as plain strings.
  const weekStart = startOfWeek(localDateOf(now));
  const inThisWeek = (instant) => instant && new Date(instant) <= now && localDateOf(instant) >= weekStart;

  const sessionsThisWeek = sessions.filter((s) => inThisWeek(s.startedAt)).length;
  const questionsThisWeek = allAnsweredQuestions(sessions).filter((q) => inThisWeek(q.answeredAt)).length;

  return {
    sessionsThisWeek,
    questionsThisWeek,
    streakDays: computeStreakDays(sessions, now),
    accuracy: computeAccuracy(sessions),
    calibration: computeCalibration(sessions),
  };
}
