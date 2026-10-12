// End-of-session reflection (SPEC.md section 6: "Short end-of-session
// prompt: what did you learn, what surprised you, what connects to what,
// what will you do differently. Stored per subject."). Finishes the
// Active->Waiting->Completed lifecycle `liveSession.js`/`readySession.js`'s
// `promptReflection` call starts: once every topic's been asked, a session
// moves to "waiting" with `reflectionPending: true` instead of completing
// outright (SPEC section 4: "Waiting: waiting on the user (a question is
// up, a reflection prompt, etc.)"). This module is the two ways out of
// that state — submit a reflection, or skip it — both of which finalize
// the session via `sessions.js`'s `endSession`.
//
// A session can span multiple subjects (sessions.js); SPEC's "stored per
// subject" doesn't say what a multi-subject session's single reflection
// does — Ada's call, section 11-style: one reflection row is stored once
// per session, tagged with every subject it covered, rather than asking
// the user to reflect once per subject. Still correctly filterable by a
// single subject later via `listReflectionsForSubject` (needed once a
// subject detail view exists to show it).

import { randomUUID } from "node:crypto";
import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";
import { getSession, endSession } from "./sessions.js";

const FILE_NAME = "reflections.json";

// A reflection answer is a few sentences, not a document; keeps whatever
// future prompt reads these back (e.g. a "big ideas" summary step) bounded.
const MAX_FIELD_CHARS = 2000;

// SPEC.md section 6's four reflection prompts, in the order given there.
export const REFLECTION_FIELDS = ["learned", "surprised", "connects", "differently"];

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, []);
}

function cleanField(value) {
  return typeof value === "string" ? value.trim().slice(0, MAX_FIELD_CHARS) : "";
}

/** Reflections tagged with the given subject, most-session-spanning
 * reflections included regardless of which other subjects they also
 * covered. Order is storage order (oldest first), same as every other
 * list* function in this codebase. */
export async function listReflectionsForSubject(appDataDir, subjectId) {
  const all = await storeFor(appDataDir).read();
  return all.filter((r) => r.subjectIds.includes(subjectId));
}

/**
 * Submits a session's end-of-session reflection and finalizes the session.
 * Every field is individually optional, but at least one must be
 * non-blank — a wholly blank submission is what `skipSessionReflection` is
 * for, not this, so the two have a real, checkable difference in the
 * stored data. Throws on an unknown session, a session not actually
 * awaiting a reflection (never reached its topics-exhausted point, or
 * already finalized), or an all-blank `answers` — all caller mistakes,
 * same posture as `sessions.js`'s own guards.
 */
export async function submitSessionReflection(appDataDir, sessionId, answers = {}) {
  const session = await getSession(appDataDir, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!session.reflectionPending) {
    throw new Error(`Session is not awaiting a reflection: ${sessionId}`);
  }

  const cleaned = {};
  for (const field of REFLECTION_FIELDS) cleaned[field] = cleanField(answers[field]);
  if (REFLECTION_FIELDS.every((field) => !cleaned[field])) {
    throw new Error("At least one reflection answer is required (use the skip endpoint for no reflection)");
  }

  const reflection = {
    id: randomUUID(),
    sessionId,
    subjectIds: session.subjectIds,
    ...cleaned,
    createdAt: new Date().toISOString(),
  };
  await storeFor(appDataDir).update((current) => [...current, reflection]);
  const ended = await endSession(appDataDir, sessionId);
  return { reflection, session: ended };
}

/**
 * Finalizes a session awaiting reflection without storing one — SPEC.md
 * describes the prompt, not a requirement that it's mandatory. Same
 * caller-mistake guards as `submitSessionReflection`, minus the all-blank
 * check (skipping is the explicit "nothing to say" path).
 */
export async function skipSessionReflection(appDataDir, sessionId) {
  const session = await getSession(appDataDir, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!session.reflectionPending) {
    throw new Error(`Session is not awaiting a reflection: ${sessionId}`);
  }
  return endSession(appDataDir, sessionId);
}
