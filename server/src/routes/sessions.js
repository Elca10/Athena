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
      const session = await createSession(appDataDir, {
        subjectIds,
        mode: req.body?.mode,
        topicIds: req.body?.topicIds,
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
