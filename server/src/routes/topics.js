import express from "express";
import { getSubject } from "../subjects.js";
import { listTopics } from "../topics.js";
import { scanSubjectForTopics } from "../topicExtraction.js";

// Mounted at /api/subjects/:id/topics — needs mergeParams so the :id from
// the parent mount point reaches this router's own handlers.
export function makeTopicsRouter(appDataDir) {
  const router = express.Router({ mergeParams: true });

  async function requireSubject(req, res) {
    const subject = await getSubject(appDataDir, req.params.id);
    if (!subject) {
      res.status(404).json({ error: `Subject not found: ${req.params.id}` });
      return null;
    }
    return subject;
  }

  router.get("/", async (req, res) => {
    if (!(await requireSubject(req, res))) return;
    res.json(await listTopics(appDataDir, req.params.id));
  });

  // Runs synchronously and returns once the scan finishes — there's no
  // session/progress-tracking UI yet for this to report into (SPEC.md's
  // "shows progress as an Active session" is a later build step), so a
  // plain request/response round-trip is the smallest correct shape for
  // now rather than a fire-and-forget job with nowhere to report to.
  router.post("/scan", async (req, res) => {
    const subject = await requireSubject(req, res);
    if (!subject) return;
    const result = await scanSubjectForTopics(appDataDir, req.params.id, { subjectName: subject.name });
    res.json(result);
  });

  return router;
}
