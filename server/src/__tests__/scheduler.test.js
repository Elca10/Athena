import { test } from "node:test";
import assert from "node:assert/strict";
import { State } from "ts-fsrs";
import { createNewCardState, isDue, reviewCard, listDueTopics, RATINGS, targetDifficultyForCard } from "../scheduler.js";

test("a brand-new card state is due immediately", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const card = createNewCardState(now);
  assert.equal(isDue(card, now), true);
});

test("a missing card state (never scheduled) is treated as due", () => {
  assert.equal(isDue(null), true);
  assert.equal(isDue(undefined), true);
});

test("reviewCard with 'good' pushes the due date into the future", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const card = createNewCardState(now);
  const next = reviewCard(card, "good", now);
  assert.equal(isDue(next, now), false);
  assert.ok(next.due > now.getTime());
  assert.equal(next.reps, 1);
});

test("reviewCard output is plain JSON — no Date objects, round-trips through JSON.stringify/parse", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const card = reviewCard(createNewCardState(now), "good", now);
  const roundTripped = JSON.parse(JSON.stringify(card));
  assert.deepEqual(roundTripped, card);
  assert.equal(typeof card.due, "number");
});

test("repeated 'good' reviews grow the interval between reviews", () => {
  let now = new Date("2026-10-06T12:00:00Z");
  let card = createNewCardState(now);
  const intervals = [];
  for (let i = 0; i < 4; i++) {
    const next = reviewCard(card, "good", now);
    intervals.push(next.due - now.getTime());
    card = next;
    now = new Date(next.due); // review again exactly when it comes due
  }
  // Each successful review should schedule at least as far out as the
  // last (FSRS intervals grow with demonstrated retention) — not
  // asserting strict growth every single step since early learning-phase
  // steps can be short and equal, only that it never shrinks.
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(intervals[i] >= intervals[i - 1], `interval ${i} (${intervals[i]}) shrank vs ${intervals[i - 1]}`);
  }
  assert.ok(intervals[intervals.length - 1] > intervals[0]);
});

test("an 'again' review after lapses keeps the next interval short", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  let card = createNewCardState(now);
  card = reviewCard(card, "good", now);
  card = reviewCard(card, "good", new Date(card.due));
  const beforeLapse = card.due;
  const lapsed = reviewCard(card, "again", new Date(card.due));
  assert.ok(lapsed.due <= beforeLapse + 24 * 60 * 60 * 1000, "a lapse should schedule a near-term re-review, not a long gap");
  assert.equal(lapsed.lapses, 1);
});

test("reviewCard rejects an unknown rating", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  assert.throws(() => reviewCard(createNewCardState(now), "great", now), /Unknown rating/);
});

test("RATINGS lists exactly the four accepted rating names", () => {
  assert.deepEqual(RATINGS, ["again", "hard", "good", "easy"]);
});

// --- targetDifficultyForCard ---------------------------------------------

test("targetDifficultyForCard treats a missing card state as intro, same as isDue treats it as due", () => {
  assert.equal(targetDifficultyForCard(null), "intro");
  assert.equal(targetDifficultyForCard(undefined), "intro");
});

test("targetDifficultyForCard is intro only for a never-reviewed (New) topic", () => {
  assert.equal(targetDifficultyForCard({ state: State.New, stability: 0 }), "intro");
});

test("targetDifficultyForCard is medium for Learning and Relearning, regardless of stability", () => {
  assert.equal(targetDifficultyForCard({ state: State.Learning, stability: 2 }), "medium");
  assert.equal(targetDifficultyForCard({ state: State.Relearning, stability: 50 }), "medium");
});

test("targetDifficultyForCard: one review is enough to stop getting intro questions (issue #20)", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  for (const rating of RATINGS) {
    const card = reviewCard(createNewCardState(now), rating, now);
    assert.notEqual(targetDifficultyForCard(card), "intro", rating);
  }
});

test("targetDifficultyForCard with examPrep never returns intro, and leaves harder targets alone (issue #18)", () => {
  assert.equal(targetDifficultyForCard(null, { examPrep: true }), "medium");
  assert.equal(targetDifficultyForCard({ state: State.New, stability: 0 }, { examPrep: true }), "medium");
  assert.equal(targetDifficultyForCard({ state: State.Learning, stability: 2 }, { examPrep: true }), "medium");
  assert.equal(targetDifficultyForCard({ state: State.Review, stability: 30 }, { examPrep: true }), "hard");
});

test("targetDifficultyForCard is medium for a Review-state topic below the stability threshold", () => {
  assert.equal(targetDifficultyForCard({ state: State.Review, stability: 5 }), "medium");
});

test("targetDifficultyForCard is hard for a Review-state topic at or above the stability threshold", () => {
  assert.equal(targetDifficultyForCard({ state: State.Review, stability: 21 }), "hard");
  assert.equal(targetDifficultyForCard({ state: State.Review, stability: 163 }), "hard");
});

test("targetDifficultyForCard reflects real FSRS progression: repeated good reviews move a topic from intro to hard", () => {
  let now = new Date("2026-10-06T12:00:00Z");
  let card = createNewCardState(now);
  assert.equal(targetDifficultyForCard(card), "intro"); // New
  for (let i = 0; i < 4; i++) {
    card = reviewCard(card, "good", now);
    now = new Date(card.due);
  }
  assert.equal(targetDifficultyForCard(card), "hard");
});

test("listDueTopics filters to due topics only and sorts soonest-due first", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const soon = { id: "a", fsrs: { due: now.getTime() - 1000 } };
  const later = { id: "b", fsrs: { due: now.getTime() - 500 } };
  const notYet = { id: "c", fsrs: { due: now.getTime() + 100_000 } };
  const neverScheduled = { id: "d", fsrs: null };
  const result = listDueTopics([notYet, later, soon, neverScheduled], now);
  assert.deepEqual(
    result.map((t) => t.id),
    ["d", "a", "b"],
  );
});
