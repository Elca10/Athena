// Study sessions (SPEC.md section 4's "Active / Waiting / Completed" right
// panel; section 5's Live vs Ready modes). This is the session data model —
// which subject(s) and topics a session covers, its mode, its current
// question (`liveSession.js` is the only writer of that field so far), and
// its Active->Waiting->Completed lifecycle. Grading isn't wired in yet,
// landing in a later build step.
//
// A session can span multiple subjects (section 4: sessions "mix topics
// ... and subjects, when the user picks multiple"), so it's its own
// top-level store rather than nested under one subject's id the way
// content/topics are.

import { randomUUID } from "node:crypto";
import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";

const FILE_NAME = "sessions.json";

export const MODES = ["live", "ready"];
export const STATUSES = ["active", "waiting", "completed"];

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, []);
}

function stringIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === "string" && id) : [];
}

export async function listSessions(appDataDir, { includeArchived = false } = {}) {
  const sessions = await storeFor(appDataDir).read();
  return includeArchived ? sessions : sessions.filter((s) => !s.archived);
}

export async function getSession(appDataDir, id) {
  const sessions = await storeFor(appDataDir).read();
  return sessions.find((s) => s.id === id) ?? null;
}

export async function createSession(appDataDir, { subjectIds, mode, topicIds = [] }) {
  const subjects = stringIds(subjectIds);
  if (subjects.length === 0) throw new Error("subjectIds must be a non-empty array");
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);

  const session = {
    id: randomUUID(),
    subjectIds: subjects,
    topicIds: stringIds(topicIds),
    mode,
    status: "active",
    startedAt: new Date().toISOString(),
    endedAt: null,
    archived: false,
    currentQuestion: null,
  };
  await storeFor(appDataDir).update((current) => [...current, session]);
  return session;
}

async function mutate(appDataDir, id, fn) {
  const sessions = await storeFor(appDataDir).update((current) => {
    const idx = current.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Session not found: ${id}`);
    const next = current.slice();
    next[idx] = fn(next[idx]);
    return next;
  });
  return sessions.find((s) => s.id === id);
}

/**
 * Moves a session between "active" and "waiting" (section 4: Athena
 * working vs. waiting on the user). A "completed" session is terminal —
 * use `endSession` to reach it, never this — so this throws rather than
 * silently reopening a finished session.
 */
export async function setSessionStatus(appDataDir, id, status) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  return mutate(appDataDir, id, (session) => {
    if (session.status === "completed") {
      throw new Error(`Session already completed: ${id}`);
    }
    return { ...session, status };
  });
}

export function endSession(appDataDir, id) {
  return mutate(appDataDir, id, (session) => ({
    ...session,
    status: "completed",
    endedAt: new Date().toISOString(),
  }));
}

/**
 * Stores a session's current question (SPEC.md section 5's Live mode:
 * "a question is up") and moves it straight to "waiting" in the same
 * store update, so a crash between the two can never leave a question
 * recorded against a still-"active" session or vice versa. A "completed"
 * session is terminal, same as `setSessionStatus`.
 */
export function setCurrentQuestion(appDataDir, id, question) {
  return mutate(appDataDir, id, (session) => {
    if (session.status === "completed") {
      throw new Error(`Session already completed: ${id}`);
    }
    return { ...session, currentQuestion: question, status: "waiting" };
  });
}

export function archiveSession(appDataDir, id) {
  return mutate(appDataDir, id, (session) => ({ ...session, archived: true }));
}

export function restoreSession(appDataDir, id) {
  return mutate(appDataDir, id, (session) => ({ ...session, archived: false }));
}
