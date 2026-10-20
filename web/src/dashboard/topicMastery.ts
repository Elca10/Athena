import type { Topic } from "./api";

// Pure classifier, deliberately kept out of api.ts: every panel's test does
// a blanket `vi.mock("./api")`, which would auto-mock this too (coming back
// `undefined` instead of running for real) if it lived there.
//
// Mirrors subjectSummary.js's own classifyMastery (ts-fsrs's State enum:
// New=0, Learning=1, Review=2, Relearning=3) so a topic's badge in
// SubjectDetailPanel always agrees with its subject card's
// new/learning/mastered counts.
export type MasteryLabel = "new" | "learning" | "mastered";

export function classifyTopicMastery(topic: Topic): MasteryLabel {
  const state = topic.fsrs?.state;
  if (state === 2) return "mastered";
  if (state === 1 || state === 3) return "learning";
  return "new";
}
