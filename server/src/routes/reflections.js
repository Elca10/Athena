import express from "express";
import { getSubject } from "../subjects.js";
import { listReflectionsForSubject } from "../reflection.js";

// Mounted at /api/subjects/:id/reflections — needs mergeParams so the :id
// from the parent mount point reaches this router's own handler, same as
// routes/topics.js. Read-only: reflections are written through
// /api/sessions/:id/reflection (see routes/sessions.js), not here.
export function makeReflectionsRouter(appDataDir) {
  const router = express.Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    const subject = await getSubject(appDataDir, req.params.id);
    if (!subject) {
      res.status(404).json({ error: `Subject not found: ${req.params.id}` });
      return;
    }
    res.json(await listReflectionsForSubject(appDataDir, req.params.id));
  });

  return router;
}
