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
 * Looks up a single topic by id regardless of which subject it belongs
 * to — needed by anything working from a session's `topicIds` (a session
 * can span multiple subjects, so the subject-scoped `listTopics` isn't
 * enough on its own). Returns `null` rather than throwing, same as
 * `getSession`/`getSubject`.
 */
export async function getTopicById(appDataDir, topicId) {
  const all = await storeFor(appDataDir).read();
  return all.find((t) => t.id === topicId) ?? null;
}

// Provenance (issue #6): `sourceContentIds` lists the content items a
// topic was found in, so a session can be limited to chosen files and
// removing a file can remove the topics that came only from it.
//   - an array: known sources (from extraction, or inferred for topics
//     that predate tracking, with `sourcesInferred: true`)
//   - null: unknown (an older topic no file's text could be matched to);
//     never auto-removed, never matched by a file filter
//   - absent: not looked at yet (older topics before inferTopicSources runs)

/**
 * Adds topics proposed for a subject, skipping any whose normalized name
 * already exists for that subject. `proposed` entries are either plain
 * strings or `{name, notes, sourceContentIds?}` objects. A proposal
 * matching an existing topic adds its sources to that topic (the same
 * topic covered in a second file), unless that topic's sources are
 * unknown. Returns the topics actually added (fresh rows, with ids) so a
 * caller can report what was new.
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
      const sources = typeof item === "object" && Array.isArray(item?.sourceContentIds) ? item.sourceContentIds : null;
      if (!key) continue;
      if (existingKeys.has(key)) {
        const idx = next.findIndex((t) => t.subjectId === subjectId && normalizeTopicName(t.name) === key);
        if (sources && idx !== -1 && Array.isArray(next[idx].sourceContentIds)) {
          next[idx] = { ...next[idx], sourceContentIds: [...new Set([...next[idx].sourceContentIds, ...sources])] };
        }
        continue;
      }
      existingKeys.add(key);
      const topic = {
        id: randomUUID(),
        subjectId,
        name: String(name).trim(),
        notes: typeof item === "object" && item ? String(item.notes ?? "").trim() : "",
        createdAt: new Date().toISOString(),
        fsrs: createNewCardState(),
        // Set once questionBankGeneration.js has given this topic an
        // initial bank — null means "still queued". Doesn't mean the bank
        // can never grow further (a Ready session draining a topic's
        // unused questions is meant to top it up per SPEC.md section 5),
        // just that the one-time initial pass has run.
        bankGeneratedAt: null,
        sourceContentIds: sources,
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

/**
 * Lists a subject's topics that have never had an initial question bank
 * generated (questionBankGeneration.js's job) — `bankGeneratedAt` is still
 * null. Order matches `listTopics`/storage order (oldest-created first),
 * not due-ness, since bank generation isn't a scheduling concern.
 */
export async function listTopicsNeedingBank(appDataDir, subjectId) {
  return (await listTopics(appDataDir, subjectId)).filter((t) => !t.bankGeneratedAt);
}

/** Marks the given topics as having had an initial question bank generated
 * (questionBankGeneration.js, after a successful batch). Ids not found are
 * silently ignored, same posture as content.js's `markTopicsExtracted`. */
export async function markBankGenerated(appDataDir, topicIds) {
  if (!topicIds.length) return;
  const idSet = new Set(topicIds);
  const now = new Date().toISOString();
  await storeFor(appDataDir).update((current) => current.map((t) => (idSet.has(t.id) ? { ...t, bankGeneratedAt: now } : t)));
}

/**
 * A content item was removed: drops it from every topic's sources, and
 * deletes the topics whose ONLY known source it was (issue #6). Topics
 * with unknown sources are left alone. Returns the deleted topics so the
 * caller can remove their bank questions and report them.
 */
export async function removeContentFromTopics(appDataDir, subjectId, contentId) {
  let removed = [];
  await storeFor(appDataDir).update((current) => {
    removed = [];
    const next = [];
    for (const t of current) {
      if (t.subjectId !== subjectId || !Array.isArray(t.sourceContentIds) || !t.sourceContentIds.includes(contentId)) {
        next.push(t);
        continue;
      }
      const remaining = t.sourceContentIds.filter((id) => id !== contentId);
      if (remaining.length) next.push({ ...t, sourceContentIds: remaining });
      else removed.push(t);
    }
    return next;
  });
  return removed;
}

/** Words that say nothing about a topic, ignored when matching names. */
const STOP_WORDS = new Set(["a", "an", "and", "the", "of", "in", "on", "for", "to", "vs", "with", "its", "how", "what", "why"]);

/**
 * Topics extracted before provenance was tracked have no sources. This
 * links each one, by script (no model call), to the subject's files whose
 * extracted text contains the topic's name, or failing that every
 * meaningful word of it. Matches are marked `sourcesInferred`; a topic no
 * file matches gets `null` (unknown). Runs once per topic: anything with
 * the field set is skipped. `readText(contentItem)` returns that item's
 * extracted text, or null.
 */
export async function inferTopicSources(appDataDir, { listContentFor, readText }) {
  const all = await storeFor(appDataDir).read();
  const pending = all.filter((t) => t.sourceContentIds === undefined);
  if (!pending.length) return 0;

  const textsBySubject = new Map();
  for (const subjectId of new Set(pending.map((t) => t.subjectId))) {
    const items = await listContentFor(subjectId);
    const texts = [];
    for (const item of items) {
      const text = await readText(item);
      if (text) texts.push({ id: item.id, text: text.toLowerCase().replace(/\s+/g, " ") });
    }
    textsBySubject.set(subjectId, texts);
  }

  const inferred = new Map();
  for (const t of pending) {
    const name = normalizeTopicName(t.name);
    const words = name.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    const matches = (textsBySubject.get(t.subjectId) ?? [])
      .filter(({ text }) => text.includes(name) || (words.length > 0 && words.every((w) => text.includes(w))))
      .map(({ id }) => id);
    inferred.set(t.id, matches.length ? matches : null);
  }

  await storeFor(appDataDir).update((current) =>
    current.map((t) =>
      t.sourceContentIds === undefined && inferred.has(t.id)
        ? { ...t, sourceContentIds: inferred.get(t.id), ...(inferred.get(t.id) ? { sourcesInferred: true } : {}) }
        : t,
    ),
  );
  return inferred.size;
}

/** The topics that would be deleted if this content item were removed:
 * those whose only known source it is. For the confirm prompt. */
export async function topicsOnlyFrom(appDataDir, subjectId, contentId) {
  return (await listTopics(appDataDir, subjectId)).filter(
    (t) => Array.isArray(t.sourceContentIds) && t.sourceContentIds.length === 1 && t.sourceContentIds[0] === contentId,
  );
}
