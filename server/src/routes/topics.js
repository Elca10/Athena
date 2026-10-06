import express from "express";
import { getSubject } from "../subjects.js";
import { listTopics, listDueTopics, recordTopicReview } from "../topics.js";
import { scanSubjectForTopics } from "../topicExtraction.js";
import { scanSubjectForBankGeneration } from "../questionBankGeneration.js";
import { listBankQuestions } from "../questionBank.js";
import { RATINGS } from "../scheduler.js";

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

  // Static route, must come before "/:topicId/review" so "due" is never
  // matched as a topic id.
  router.get("/due", async (req, res) => {
    if (!(await requireSubject(req, res))) return;
    res.json(await listDueTopics(appDataDir, req.params.id));
  });

  router.get("/:topicId/bank", async (req, res) => {
    if (!(await requireSubject(req, res))) return;
    const topics = await listTopics(appDataDir, req.params.id);
    if (!topics.some((t) => t.id === req.params.topicId)) {
      res.status(404).json({ error: `Topic not found: ${req.params.topicId}` });
      return;
    }
    res.json(await listBankQuestions(appDataDir, req.params.topicId));
  });

  // Same synchronous-round-trip shape as "/scan" (topic extraction) —
  // there's no progress-tracking UI to report into yet, so a plain
  // request/response is the smallest correct shape for now.
  router.post("/bank/scan", async (req, res) => {
    const subject = await requireSubject(req, res);
    if (!subject) return;
    const result = await scanSubjectForBankGeneration(appDataDir, req.params.id, { subjectName: subject.name });
    res.json(result);
  });

  router.post("/:topicId/review", async (req, res) => {
    if (!(await requireSubject(req, res))) return;
    const { rating } = req.body ?? {};
    if (!RATINGS.includes(rating)) {
      res.status(400).json({ error: `rating must be one of ${RATINGS.join(", ")}` });
      return;
    }
    const topics = await listTopics(appDataDir, req.params.id);
    if (!topics.some((t) => t.id === req.params.topicId)) {
      res.status(404).json({ error: `Topic not found: ${req.params.topicId}` });
      return;
    }
    const updated = await recordTopicReview(appDataDir, req.params.topicId, rating);
    res.json(updated);
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
