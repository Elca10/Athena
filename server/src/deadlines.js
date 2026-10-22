// Deadlines (SPEC.md section 9, SPEC-v2.md section 2): class or exam dates
// the user enters by hand — subject, title, date, and optionally which of
// the subject's topics it covers. `studying` is the user's choice of
// whether Athena should pace the schedule for it (a deadline can be on
// record without being studied for, e.g. a homework hand-in).
//
// `topicIds`: an empty list means the deadline covers the whole subject
// (same convention as a session's `contentIds`: nothing picked = all).
// A non-empty list only ever covers those topics; ids of topics that have
// since been removed are simply ignored when read (`coveredTopicIds`), so
// a deadline whose topics are all gone covers nothing rather than
// silently widening to the whole subject.
//
// `source` is "manual" for hand-entered deadlines and "canvas" for ones
// imported from the user's Canvas calendar feed (canvasFeed.js), which
// also carry the feed event's UID as `externalId`. Neither can be set
// over HTTP: only canvasFeed.js passes them.
//
// Dates are local calendar dates (localDate.js). Missing file = no
// deadlines, so existing installs need no migration.

import { randomUUID } from "node:crypto";
import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";
import { listTopics } from "./topics.js";
import { isValidDateString } from "./localDate.js";

const FILE_NAME = "deadlines.json";

export const MAX_DEADLINE_TITLE_LENGTH = 120;
export const MAX_DEADLINES_PER_SUBJECT = 100;

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, []);
}

function byDate(a, b) {
  return a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt);
}

/** Every deadline, every subject, soonest first. */
export async function listAllDeadlines(appDataDir) {
  return (await storeFor(appDataDir).read()).slice().sort(byDate);
}

export async function listDeadlines(appDataDir, subjectId) {
  return (await listAllDeadlines(appDataDir)).filter((d) => d.subjectId === subjectId);
}

function cleanTitle(title) {
  const trimmed = typeof title === "string" ? title.trim().replace(/\s+/g, " ") : "";
  if (!trimmed) throw new Error("Give the deadline a title, e.g. Midterm exam.");
  if (trimmed.length > MAX_DEADLINE_TITLE_LENGTH) {
    throw new Error(`Deadline titles can be at most ${MAX_DEADLINE_TITLE_LENGTH} characters.`);
  }
  return trimmed;
}

function cleanDate(date) {
  if (!isValidDateString(date)) throw new Error("Pick a valid date for the deadline.");
  return date;
}

async function cleanTopicIds(appDataDir, subjectId, topicIds) {
  if (topicIds === undefined || topicIds === null) return [];
  if (!Array.isArray(topicIds) || topicIds.some((id) => typeof id !== "string")) {
    throw new Error("topicIds must be a list of topic ids.");
  }
  const known = new Set((await listTopics(appDataDir, subjectId)).map((t) => t.id));
  const unique = [...new Set(topicIds)];
  if (unique.some((id) => !known.has(id))) {
    throw new Error("Some of those topics no longer exist. Reopen the subject and pick again.");
  }
  return unique;
}

/** Throws (a user-facing message) on invalid input; the route turns it
 * into a 400. */
export async function createDeadline(
  appDataDir,
  subjectId,
  { title, date, topicIds, studying = true },
  { source = "manual", externalId } = {},
) {
  const now = new Date().toISOString();
  const deadline = {
    id: randomUUID(),
    subjectId,
    title: cleanTitle(title),
    date: cleanDate(date),
    topicIds: await cleanTopicIds(appDataDir, subjectId, topicIds),
    studying: studying !== false,
    source,
    ...(externalId ? { externalId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await storeFor(appDataDir).update((current) => {
    if (current.filter((d) => d.subjectId === subjectId).length >= MAX_DEADLINES_PER_SUBJECT) {
      throw new Error(`A subject can have at most ${MAX_DEADLINES_PER_SUBJECT} deadlines. Delete some old ones first.`);
    }
    return [...current, deadline];
  });
  return deadline;
}

export class DeadlineNotFoundError extends Error {}

/** Partial update: only the fields present in `changes` are touched. */
export async function updateDeadline(appDataDir, subjectId, id, changes = {}) {
  const patch = {};
  if ("title" in changes) patch.title = cleanTitle(changes.title);
  if ("date" in changes) patch.date = cleanDate(changes.date);
  if ("topicIds" in changes) patch.topicIds = await cleanTopicIds(appDataDir, subjectId, changes.topicIds);
  if ("studying" in changes) {
    if (typeof changes.studying !== "boolean") throw new Error("studying must be true or false.");
    patch.studying = changes.studying;
  }
  const all = await storeFor(appDataDir).update((current) => {
    const idx = current.findIndex((d) => d.id === id && d.subjectId === subjectId);
    if (idx === -1) throw new DeadlineNotFoundError(`Deadline not found: ${id}`);
    const next = current.slice();
    next[idx] = { ...next[idx], ...patch, updatedAt: new Date().toISOString() };
    return next;
  });
  return all.find((d) => d.id === id);
}

export async function deleteDeadline(appDataDir, subjectId, id) {
  await storeFor(appDataDir).update((current) => {
    if (!current.some((d) => d.id === id && d.subjectId === subjectId)) {
      throw new DeadlineNotFoundError(`Deadline not found: ${id}`);
    }
    return current.filter((d) => d.id !== id);
  });
}

/** The topic ids a deadline actually covers right now, given the
 * subject's current topics (see the header for the empty-list rule). */
export function coveredTopicIds(deadline, subjectTopics) {
  const ids = Array.isArray(deadline.topicIds) ? deadline.topicIds : [];
  if (ids.length === 0) return subjectTopics.map((t) => t.id);
  const existing = new Set(subjectTopics.map((t) => t.id));
  return ids.filter((id) => existing.has(id));
}

/** The soonest deadline on or after `today` (YYYY-MM-DD), or null. */
export function nextDeadline(deadlines, today) {
  return deadlines.filter((d) => d.date >= today).sort(byDate)[0] ?? null;
}
