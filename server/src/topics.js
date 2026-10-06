// Planned topics (SPEC.md section 7: "seed them as planned topics") — the
// output of topic extraction (topicExtraction.js), which question-bank
// generation and the scheduler will later read. This module is only the
// data model: list and add, deduped by name within a subject.
//
// Dedup key is the normalized (trimmed, lowercased, whitespace-collapsed)
// name — the same topic proposed again from a later batch of content, or
// re-proposed verbatim by a flaky reply, must not create a second row.

import { randomUUID } from "node:crypto";
import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";
import { createNewCardState, reviewCard, listDueTopics as pickDueTopics } from "./scheduler.js";

const FILE_NAME = "topics.json";

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, []);
}

export function normalizeTopicName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export async function listTopics(appDataDir, subjectId) {
  const all = await storeFor(appDataDir).read();
  return all.filter((t) => t.subjectId === subjectId);
}

/**
 * Adds topics proposed for a subject, skipping any whose normalized name
 * already exists for that subject. `proposed` entries are either plain
 * strings or `{name, notes}` objects. Returns the topics actually added
 * (fresh rows, with ids) so a caller can report what was new.
 */
export async function addPlannedTopics(appDataDir, subjectId, proposed) {
  let added = [];
  await storeFor(appDataDir).update((current) => {
    const existingKeys = new Set(current.filter((t) => t.subjectId === subjectId).map((t) => normalizeTopicName(t.name)));
    added = [];
    const next = current.slice();
    for (const item of proposed) {
      const name = typeof item === "string" ? item : item?.name;
      const key = normalizeTopicName(name);
      if (!key || existingKeys.has(key)) continue;
      existingKeys.add(key);
      const topic = {
        id: randomUUID(),
        subjectId,
        name: String(name).trim(),
        notes: typeof item === "object" && item ? String(item.notes ?? "").trim() : "",
        createdAt: new Date().toISOString(),
        fsrs: createNewCardState(),
      };
      next.push(topic);
      added.push(topic);
    }
    return next;
  });
  return added;
}

/**
 * Lists a subject's due topics (soonest-due first) per the FSRS card state
 * stored on each topic — a brand-new, never-reviewed topic is always due.
 */
export async function listDueTopics(appDataDir, subjectId, now = new Date()) {
  return pickDueTopics(await listTopics(appDataDir, subjectId), now);
}

/**
 * Records a review outcome for one topic (SPEC.md section 6's calibration/
 * spaced-repetition loop) and returns the updated topic. `ratingName` is
 * one of scheduler.js's RATINGS ("again"/"hard"/"good"/"easy"); an unknown
 * rating or topic id throws — routes/topics.js turns that into a 400/404.
 */
export async function recordTopicReview(appDataDir, topicId, ratingName, now = new Date()) {
  const all = await storeFor(appDataDir).update((current) => {
    const index = current.findIndex((t) => t.id === topicId);
    if (index === -1) throw new Error(`Topic not found: ${topicId}`);
    const next = current.slice();
    next[index] = {
      ...next[index],
      fsrs: reviewCard(next[index].fsrs, ratingName, now),
      lastReviewedAt: now.toISOString(),
    };
    return next;
  });
  return all.find((t) => t.id === topicId);
}
