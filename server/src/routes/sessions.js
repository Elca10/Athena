import express from "express";
import { getSubject } from "../subjects.js";
import {
  listSessions,
  getSession,
  createSession,
  setSessionStatus,
  endSession,
  promptReflection,
  archiveSession,
  restoreSession,
  STATUSES,
} from "../sessions.js";
import { buildSessionTopicIds, explainNothingDue } from "../sessionBuilder.js";
import { generateNextLiveQuestion, submitLiveAnswer } from "../liveSession.js";
import { generateNextReadyQuestion, submitReadyAnswer, submitReadySelfGrade, publicQuestionView } from "../readySession.js";
import { submitSessionReflection, skipSessionReflection } from "../reflection.js";

// Scrubs a session's `currentQuestion` before it reaches a client, same as
// `/ready/question` already did inline — every route here that can hand
// back a session read from storage (rather than one it just mutated in a
// shape it already controls) needs this, or a Waiting Ready session's raw
// answer key goes out with it (readySession.js's `publicQuestionView` doc
// comment has the detail: resuming a Waiting session is exactly why this
// matters now). A no-op for a null `currentQuestion` or a Live question,
// neither of which carries the fields `publicQuestionView` strips.
function publicSessionView(session) {
  const view = presentStatus(session);
  if (!view.currentQuestion) return view;
  return { ...view, currentQuestion: publicQuestionView(view.currentQuestion) };
}

// Sessions with a Live model turn running right now. "active" in storage
// also covers sessions merely BETWEEN questions (after an answer, after a
// failed turn, before the first question), where nothing is running and
// the user just left. Shown as "active" those sat in the dashboard's
// Active column as "Working…" with no way back in, so they're presented
// as "waiting" (resumable) unless a turn really is in flight.
const turnsInFlight = new Set();

function presentStatus(session) {
  if (session.status !== "active" || turnsInFlight.has(session.id)) return session;
  return { ...session, status: "waiting" };
}

async function duringTurn(sessionId, fn) {
  turnsInFlight.add(sessionId);
  try {
    return await fn();
  } finally {
    turnsInFlight.delete(sessionId);
  }
}

// Mounted at /api/sessions — top-level, not nested under a subject, since
// one session can cover multiple subjects (SPEC.md section 4).
export function makeSessionsRouter(appDataDir) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    const sessions = await listSessions(appDataDir, { includeArchived });
    res.json(sessions.map(publicSessionView));
  });

  router.post("/", async (req, res) => {
    const subjectIds = Array.isArray(req.body?.subjectIds) ? req.body.subjectIds : [];
    for (const id of subjectIds) {
      if (!(await getSubject(appDataDir, id))) {
        res.status(400).json({ error: `Subject not found: ${id}` });
        return;
      }
    }
    try {
      // A caller can still hand us an explicit topicIds (e.g. a
      // not-yet-built "pick specific topics" flow); only auto-build from
      // each subject's due topics (section 6's interleaving) when none
      // was given.
      const requestedTopicIds = Array.isArray(req.body?.topicIds) ? req.body.topicIds : [];
      const reviewAhead = req.body?.reviewAhead === true;
      const contentIds = Array.isArray(req.body?.contentIds) ? req.body.contentIds.filter((id) => typeof id === "string") : null;
      const topicIds = requestedTopicIds.length
        ? requestedTopicIds
        : await buildSessionTopicIds(appDataDir, subjectIds, { reviewAhead, contentIds });
      // An empty session can't ask anything; refuse with a reason instead
      // of creating one that dead-ends on its first question. `nothingDue`
      // lets the UI offer "Review ahead anyway" when there ARE topics.
      if (!topicIds.length && subjectIds.length) {
        const hasTopics = (await buildSessionTopicIds(appDataDir, subjectIds, { reviewAhead: true, limit: 1, contentIds })).length > 0;
        res.status(400).json({ error: await explainNothingDue(appDataDir, subjectIds, { contentIds }), nothingDue: hasTopics });
        return;
      }
      const session = await createSession(appDataDir, {
        subjectIds,
        mode: req.body?.mode,
        topicIds,
        contentIds: contentIds ?? [],
      });
      res.status(201).json(publicSessionView(session));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get("/:id", async (req, res) => {
    const session = await getSession(appDataDir, req.params.id);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    res.json(publicSessionView(session));
  });

  // Triggers Live mode's next model-generated question (SPEC.md section
  // 5) — the UI calls this same route both for a session's very first
  // question and again after each answer is recorded; `pickNextTopicId`
  // decides which topic (if any) is next. Runs synchronously and returns
  // once the turn finishes — same "no progress-tracking UI to report
  // into yet" reasoning as routes/topics.js's /scan route. Validation
  // failures (wrong mode, already has a question, no topics at all) are
  // caller mistakes and 400; once every topic's been asked, the session
  // ends itself and this returns 200 with `{ok: true, done: true, ...}`
  // rather than 400 — that's not a caller mistake. A model-call failure
  // is a real, recoverable "try again later" outcome, not a request
  // error, so it also comes back as 200 with `{ok: false, ...}` and the
  // session left unchanged, same as /scan's result shape.
  router.post("/:id/live/question", async (req, res) => {
    if (!(await getSession(appDataDir, req.params.id))) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    try {
      res.json(await duringTurn(req.params.id, () => generateNextLiveQuestion(appDataDir, req.params.id)));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Grades the user's answer to the session's current question (SPEC.md
  // section 5) and applies the result to FSRS scheduling. Same
  // synchronous-round-trip and 400-vs-{ok:false} split as
  // /live/question above: a bad request (unknown session, wrong mode, no
  // current question, malformed answerText/confidence) is a caller
  // mistake and 400; a model-call failure or unparseable/invalid-rating
  // reply is a recoverable "try again" outcome, so it comes back as 200
  // with `{ok: false, ...}` and the session/topic left unchanged.
  router.post("/:id/live/answer", async (req, res) => {
    if (!(await getSession(appDataDir, req.params.id))) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    try {
      res.json(
        await submitLiveAnswer(appDataDir, req.params.id, {
          answerText: req.body?.answerText,
          confidence: req.body?.confidence,
        }),
      );
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Ready mode's counterpart to /live/question — same synchronous
  // round-trip, but never shells out to a model (SPEC.md section 5's
  // near-zero-model-usage goal). `generateNextReadyQuestion` already
  // decides whether to serve a question, end a finished session, or
  // report an empty bank; this route's only job is to scrub the served
  // question's answer-key fields before they reach the client, same
  // `publicSessionView` every other session-returning route here uses now.
  // An empty-bank result (`noBank: true`) isn't a caller mistake either,
  // so it's 200, same as a Live model-call failure.
  router.post("/:id/ready/question", async (req, res) => {
    if (!(await getSession(appDataDir, req.params.id))) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    try {
      const result = await generateNextReadyQuestion(appDataDir, req.params.id);
      if (result.ok && result.session) result.session = publicSessionView(result.session);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Submits an answer to a Ready question. Multiple choice/cloze grade and
  // finalize in this one call (`finalized: true`, same shape as
  // /live/answer plus `isCorrect`); every other type instead reveals the
  // model answer/rubric here (`finalized: false`) and waits for
  // /ready/self-grade to finish the job (SPEC.md section 5's two-step
  // self-grading flow). No model call either way, so every failure here
  // is a caller mistake — 400, never the {ok:false} "try again" shape
  // /live/answer uses for a real model-call failure.
  router.post("/:id/ready/answer", async (req, res) => {
    if (!(await getSession(appDataDir, req.params.id))) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    try {
      const result = await submitReadyAnswer(appDataDir, req.params.id, {
        answerText: req.body?.answerText,
        selectedIndex: req.body?.selectedIndex,
        confidence: req.body?.confidence,
      });
      // `finalized: false` means the reveal in this very response IS the
      // first legitimate disclosure of modelAnswer/rubric/misconceptions —
      // scrubbing them here would contradict the route's own job. Only
      // `session.currentQuestion` (now carrying `pendingAnswer`, so
      // `publicSessionView` already keeps them) needs normalizing.
      result.session = publicSessionView(result.session);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Finishes a self-graded Ready question once /ready/answer has stashed a
  // pending answer and revealed the rubric. Same all-400 posture as
  // /ready/answer above — no model call to fail here either.
  router.post("/:id/ready/self-grade", async (req, res) => {
    if (!(await getSession(appDataDir, req.params.id))) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    try {
      const result = await submitReadySelfGrade(appDataDir, req.params.id, { selfGrades: req.body?.selfGrades });
      result.session = publicSessionView(result.session);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Submits the end-of-session reflection (SPEC.md section 6) and
  // finalizes the session — only valid once the session is actually
  // awaiting one (`reflectionPending`, set by liveSession.js's/
  // readySession.js's `promptReflection` once every topic's been asked).
  // No model call happens here, so every failure (unknown session, not
  // awaiting reflection, every field blank) is a caller mistake — 400,
  // same all-caller-mistake posture as /ready/answer.
  router.post("/:id/reflection", async (req, res) => {
    if (!(await getSession(appDataDir, req.params.id))) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    try {
      res.json(
        await submitSessionReflection(appDataDir, req.params.id, {
          learned: req.body?.learned,
          surprised: req.body?.surprised,
          connects: req.body?.connects,
          differently: req.body?.differently,
        }),
      );
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Finalizes a session awaiting reflection without storing one.
  router.post("/:id/reflection/skip", async (req, res) => {
    if (!(await getSession(appDataDir, req.params.id))) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    try {
      res.json(await skipSessionReflection(appDataDir, req.params.id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Two distinct failure modes (bad status value vs. unknown session), so
  // the format check runs before an existence check, same reasoning as
  // routes/topics.js's rating validation on its review route.
  router.post("/:id/status", async (req, res) => {
    const { status } = req.body ?? {};
    if (!STATUSES.includes(status)) {
      res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
      return;
    }
    if (!(await getSession(appDataDir, req.params.id))) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    try {
      res.json(publicSessionView(await setSessionStatus(appDataDir, req.params.id, status)));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // "End session" in the UI: before this there was no way to stop a
  // session early, so half-done ones piled up in Waiting. With at least
  // one answer it goes to the end-of-session reflection like a finished
  // session; with none it just closes. Whatever question was on screen
  // and unanswered doesn't count.
  router.post("/:id/finish", async (req, res) => {
    const session = await getSession(appDataDir, req.params.id);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    if (session.status === "completed") {
      res.json({ reflection: false, session: publicSessionView(session) });
      return;
    }
    if (session.history?.length) {
      res.json({ reflection: true, session: publicSessionView(await promptReflection(appDataDir, session.id)) });
    } else {
      res.json({ reflection: false, session: publicSessionView(await endSession(appDataDir, session.id)) });
    }
  });

  router.post("/:id/end", async (req, res) => {
    try {
      res.json(publicSessionView(await endSession(appDataDir, req.params.id)));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.post("/:id/archive", async (req, res) => {
    try {
      res.json(publicSessionView(await archiveSession(appDataDir, req.params.id)));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.post("/:id/restore", async (req, res) => {
    try {
      res.json(publicSessionView(await restoreSession(appDataDir, req.params.id)));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  return router;
}
