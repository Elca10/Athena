// Study sessions (SPEC.md section 4's "Active / Waiting / Completed" right
// panel; section 5's Live vs Ready modes). This is the session data model —
// which subject(s) and topics a session covers, its mode, its current
// question, its answered-question `history`, and its
// Active->Waiting->Completed lifecycle. `liveSession.js` is the only
// writer of `currentQuestion`/`history` so far (Ready mode's local
// self-grading will likely reuse `recordAnswer` once it exists).
//
// A session can span multiple subjects (section 4: sessions "mix topics
// ... and subjects, when the user picks multiple"), so it's its own
// top-level store rather than nested under one subject's id the way
// content/topics are.

import { randomUUID } from "node:crypto";
import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";

const FILE_NAME = "sessions.json";

export const MODES = ["live", "ready", "hybrid"];
export const STATUSES = ["active", "waiting", "completed"];
// "learn": questions follow each topic's progress, new topics start with
// an intro question. "exam": the user already knows the material and is
// revising (issue #18), so no intro or attempt-first questions.
export const FOCUSES = ["learn", "exam"];

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

export async function createSession(appDataDir, { subjectIds, mode, topicIds = [], contentIds = [], focus = "learn" }) {
  const subjects = stringIds(subjectIds);
  if (subjects.length === 0) throw new Error("subjectIds must be a non-empty array");
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  if (!FOCUSES.includes(focus)) throw new Error(`focus must be one of ${FOCUSES.join(", ")}`);

  const session = {
    id: randomUUID(),
    subjectIds: subjects,
    topicIds: stringIds(topicIds),
    // The files the user limited it to (issue #6), so switching modes or
    // reviewing ahead keeps the same choice. Empty: all content.
    contentIds: stringIds(contentIds),
    mode,
    focus,
    status: "active",
    startedAt: new Date().toISOString(),
    endedAt: null,
    archived: false,
    currentQuestion: null,
    history: [],
    reflectionPending: false,
  };
  await storeFor(appDataDir).update((current) => [...current, session]);
  return session;
}

/**
 * At server start nothing can be mid-flight, so any "active" session (Athena
 * was working on it: between questions, or mid model turn) was interrupted
 * by a restart, an update, a crash or a reboot. Moving it to "waiting" puts
 * it in the dashboard's Waiting list, whose Resume fetches the next question
 * (StudyFlow), instead of leaving it stuck under Active with no way back in.
 * Returns how many sessions were moved.
 */
export async function reconcileInterruptedSessions(appDataDir) {
  const store = storeFor(appDataDir);
  // Read first: a normal start has nothing to fix and must not rewrite (or
  // back up) the file at all.
  if (!(await store.read()).some(needsReconcile)) return 0;
  let moved = 0;
  await store.update((current) =>
    current.map((s) => {
      if (!needsReconcile(s)) return s;
      moved++;
      // Sessions created with no topics at all (possible before the
      // create route refused them) can never ask anything: close them.
      if (isEmptySession(s)) return { ...s, status: "completed", endedAt: s.endedAt ?? new Date().toISOString() };
      return { ...s, status: "waiting" };
    }),
  );
  return moved;
}

/**
 * Topics were deleted (their only content was removed — issue #6): takes
 * them out of every unfinished session, so resuming one never hits
 * "Topic not found". A question up for a deleted topic is dropped, and a
 * session left with nothing asked and nothing to ask is closed. History
 * stays as it was. Returns how many sessions changed.
 */
export async function dropTopicsFromSessions(appDataDir, topicIds) {
  const gone = new Set(topicIds);
  if (!gone.size) return 0;
  const store = storeFor(appDataDir);
  const touches = (s) =>
    s.status !== "completed" && ((s.topicIds ?? []).some((id) => gone.has(id)) || gone.has(s.currentQuestion?.topicId));
  if (!(await store.read()).some(touches)) return 0;
  let changed = 0;
  await store.update((current) =>
    current.map((s) => {
      if (!touches(s)) return s;
      changed++;
      const next = {
        ...s,
        topicIds: (s.topicIds ?? []).filter((id) => !gone.has(id)),
        currentQuestion: gone.has(s.currentQuestion?.topicId) ? null : s.currentQuestion,
      };
      return isEmptySession(next) ? { ...next, status: "completed", endedAt: next.endedAt ?? new Date().toISOString() } : next;
    }),
  );
  return changed;
}

function isEmptySession(s) {
  return s.status !== "completed" && !(s.topicIds?.length) && !(s.history?.length) && !s.currentQuestion;
}

function needsReconcile(s) {
  return s.status === "active" || isEmptySession(s);
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
    reflectionPending: false,
  }));
}

/**
 * Moves a session to "waiting" for an end-of-session reflection (SPEC.md
 * section 6; section 4's "Waiting: waiting on the user (a question is up,
 * a reflection prompt, etc.)") instead of completing it outright once its
 * topics are exhausted — `liveSession.js`/`readySession.js` call this in
 * place of `endSession` when `pickNextTopicId` has nothing left. The
 * session only reaches "completed" once `reflection.js`'s
 * `submitSessionReflection`/`skipSessionReflection` finalizes it via
 * `endSession`. A "completed" session is terminal, same guard as every
 * other mutator here.
 */
export function promptReflection(appDataDir, id) {
  return mutate(appDataDir, id, (session) => {
    if (session.status === "completed") {
      throw new Error(`Session already completed: ${id}`);
    }
    return { ...session, status: "waiting", reflectionPending: true, currentQuestion: null };
  });
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

/**
 * Stashes a Ready self-graded question's answer+confidence onto
 * `currentQuestion` without finalizing it — status stays "waiting".
 * SPEC.md section 5's self-grading flow needs to reveal the model answer
 * and rubric between the user submitting an answer and submitting their
 * self-grade (readySession.js), so the FSRS rating — and therefore the
 * real `recordAnswer` finalize — can't happen in the same step. Throws if
 * there's no current question, it already has a pending answer, or the
 * session is completed — all caller-mistake conditions, same posture as
 * `setCurrentQuestion`.
 */
export function recordPendingAnswer(appDataDir, id, pendingAnswer) {
  return mutate(appDataDir, id, (session) => {
    if (session.status === "completed") {
      throw new Error(`Session already completed: ${id}`);
    }
    if (!session.currentQuestion) {
      throw new Error(`Session has no current question to answer: ${id}`);
    }
    if (session.currentQuestion.pendingAnswer) {
      throw new Error(`Session's current question already has a pending answer: ${id}`);
    }
    return { ...session, currentQuestion: { ...session.currentQuestion, pendingAnswer } };
  });
}

/**
 * Appends a finished question+answer to a session's `history` and clears
 * `currentQuestion`, moving status back to "active" — ready for whatever
 * generates the next question. A session with no current question can't
 * record an answer (there's nothing to answer), and a "completed" session
 * is terminal same as `setCurrentQuestion`; both throw rather than
 * silently no-opping, since either means the caller is out of sync with
 * the session's real state.
 */
export function recordAnswer(appDataDir, id, entry) {
  return mutate(appDataDir, id, (session) => {
    if (session.status === "completed") {
      throw new Error(`Session already completed: ${id}`);
    }
    if (!session.currentQuestion) {
      throw new Error(`Session has no current question to answer: ${id}`);
    }
    return {
      ...session,
      history: [...(session.history ?? []), entry],
      currentQuestion: null,
      status: "active",
    };
  });
}

export function archiveSession(appDataDir, id) {
  return mutate(appDataDir, id, (session) => ({ ...session, archived: true }));
}

export function restoreSession(appDataDir, id) {
  return mutate(appDataDir, id, (session) => ({ ...session, archived: false }));
}
