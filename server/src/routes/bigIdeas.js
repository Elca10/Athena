import express from "express";
import { getSubject } from "../subjects.js";
import { getBigIdeas, setBigIdeas } from "../bigIdeas.js";

// Mounted at /api/subjects/:id/big-ideas — needs mergeParams so the :id
// from the parent mount point reaches this router's own handler, same as
// routes/reflections.js. Unlike reflections (read-only here), this one
// also takes the PUT that saves the user's own edit; there's no model
// call anywhere on this path.
export function makeBigIdeasRouter(appDataDir) {
  const router = express.Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    const subject = await getSubject(appDataDir, req.params.id);
    if (!subject) {
      res.status(404).json({ error: `Subject not found: ${req.params.id}` });
      return;
    }
    res.json(await getBigIdeas(appDataDir, req.params.id));
  });

  router.put("/", async (req, res) => {
    const subject = await getSubject(appDataDir, req.params.id);
    if (!subject) {
      res.status(404).json({ error: `Subject not found: ${req.params.id}` });
      return;
    }
    try {
      res.json(await setBigIdeas(appDataDir, req.params.id, req.body?.text));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
