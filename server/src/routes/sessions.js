import express from "express";
import { getSubject } from "../subjects.js";
import {
  listSessions,
  getSession,
  createSession,
  setSessionStatus,
  endSession,
  archiveSession,
  restoreSession,
  STATUSES,
} from "../sessions.js";
import { buildSessionTopicIds } from "../sessionBuilder.js";
import { generateNextLiveQuestion, submitLiveAnswer } from "../liveSession.js";

// Mounted at /api/sessions — top-level, not nested under a subject, since
// one session can cover multiple subjects (SPEC.md section 4).
export function makeSessionsRouter(appDataDir) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    res.json(await listSessions(appDataDir, { includeArchived }));
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
      const topicIds = requestedTopicIds.length ? requestedTopicIds : await buildSessionTopicIds(appDataDir, subjectIds);
      const session = await createSession(appDataDir, {
        subjectIds,
        mode: req.body?.mode,
        topicIds,
      });
      res.status(201).json(session);
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
    res.json(session);
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
      res.json(await generateNextLiveQuestion(appDataDir, req.params.id));
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
      res.json(await setSessionStatus(appDataDir, req.params.id, status));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/:id/end", async (req, res) => {
    try {
      res.json(await endSession(appDataDir, req.params.id));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.post("/:id/archive", async (req, res) => {
    try {
      res.json(await archiveSession(appDataDir, req.params.id));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.post("/:id/restore", async (req, res) => {
    try {
      res.json(await restoreSession(appDataDir, req.params.id));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  return router;
}
