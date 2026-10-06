// FSRS-based review scheduling (SPEC.md section 6: "a real scheduling
// algorithm — recommend FSRS ... replacing [a hand-rolled SM-2-lite]";
// section 11 leaves "library vs. own port" to Ada). Decision: use the
// `ts-fsrs` library (MIT, the reference TypeScript/JS port of the FSRS
// algorithm, maintained by the algorithm's own open-spaced-repetition
// org) rather than hand-porting the math ourselves — FSRS's stability/
// difficulty formulas are the whole value of the algorithm, and a typo'd
// reimplementation would silently produce plausible-looking but wrong
// intervals with no easy way to notice. A hand-rolled bucket scheduler is
// reasonable for a few status buckets (fine elsewhere); FSRS is not that.
//
// Pure logic only, no filesystem/storage access — takes a topic's
// serializable `fsrs` card state in, returns a new one out, so it's
// testable with fixture data alone. `topics.js` owns persistence.

import { createEmptyCard, fsrs, Rating } from "ts-fsrs";

const scheduler = fsrs();

// Exposed as plain lowercase strings so callers (routes, eventually the
// UI) never need to import ts-fsrs's own enum just to say "good".
export const RATINGS = ["again", "hard", "good", "easy"];

const RATING_BY_NAME = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

// ts-fsrs's card shape uses `Date` objects for `due`/`last_review`, which
// don't survive a JSON round-trip through the store — serialize both to
// epoch ms so a card state is plain, storable JSON at every step.
function serializeCard(card) {
  return {
    ...card,
    due: card.due.getTime(),
    last_review: card.last_review ? card.last_review.getTime() : null,
  };
}

function deserializeCard(cardState) {
  return {
    ...cardState,
    due: new Date(cardState.due),
    last_review: cardState.last_review ? new Date(cardState.last_review) : null,
  };
}

/** A brand-new topic's initial scheduling state — due immediately, so an
 * unreviewed topic always shows up in `isDue`/`listDueTopics`. */
export function createNewCardState(now = new Date()) {
  return serializeCard(createEmptyCard(now));
}

export function isDue(cardState, now = new Date()) {
  if (!cardState) return true; // never scheduled yet (shouldn't happen once seeded, but fail open)
  return cardState.due <= now.getTime();
}

/**
 * Applies a review outcome to a card's current state. `ratingName` is one
 * of RATINGS (case-sensitive, lowercase). Throws on an unknown rating —
 * callers at the API boundary (routes/topics.js) are responsible for
 * turning that into a 400, same as any other invalid-input rejection in
 * this codebase.
 */
export function reviewCard(cardState, ratingName, now = new Date()) {
  const rating = RATING_BY_NAME[ratingName];
  if (rating === undefined) {
    throw new Error(`Unknown rating: ${ratingName} (expected one of ${RATINGS.join(", ")})`);
  }
  const card = cardState ? deserializeCard(cardState) : createEmptyCard(now);
  const { card: nextCard } = scheduler.next(card, now, rating);
  return serializeCard(nextCard);
}

/** Topics (each with a `.fsrs` card state) that are due now, soonest-due
 * first. Plain filter+sort — no cross-subject interleaving or exam-urgency
 * weighting yet, since neither multi-subject session building nor
 * deadlines (SPEC.md section 9) exist as a build step yet. */
export function listDueTopics(topics, now = new Date()) {
  return topics
    .filter((t) => isDue(t.fsrs, now))
    .sort((a, b) => (a.fsrs?.due ?? 0) - (b.fsrs?.due ?? 0));
}
