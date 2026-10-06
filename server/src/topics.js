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
      };
      next.push(topic);
      added.push(topic);
    }
    return next;
  });
  return added;
}
