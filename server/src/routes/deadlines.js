import express from "express";
import { getSubject } from "../subjects.js";
import { listDeadlines, createDeadline, updateDeadline, deleteDeadline, DeadlineNotFoundError } from "../deadlines.js";

// Mounted at /api/subjects/:id/deadlines (mergeParams for the parent :id).
// Invalid input is a 400 with the user-facing reason from deadlines.js.
export function makeDeadlinesRouter(appDataDir) {
  const router = express.Router({ mergeParams: true });

  async function requireSubject(req, res) {
    const subject = await getSubject(appDataDir, req.params.id);
    if (!subject) {
      res.status(404).json({ error: `Subject not found: ${req.params.id}` });
      return null;
    }
    return subject;
  }

  function fail(res, err) {
    res.status(err instanceof DeadlineNotFoundError ? 404 : 400).json({ error: err.message });
  }

  router.get("/", async (req, res) => {
    if (!(await requireSubject(req, res))) return;
    res.json(await listDeadlines(appDataDir, req.params.id));
  });

  router.post("/", async (req, res) => {
    if (!(await requireSubject(req, res))) return;
    try {
      const { title, date, topicIds, studying } = req.body ?? {};
      res.status(201).json(await createDeadline(appDataDir, req.params.id, { title, date, topicIds, studying }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch("/:deadlineId", async (req, res) => {
    if (!(await requireSubject(req, res))) return;
    const body = req.body ?? {};
    const changes = Object.fromEntries(["title", "date", "topicIds", "studying"].filter((k) => k in body).map((k) => [k, body[k]]));
    try {
      res.json(await updateDeadline(appDataDir, req.params.id, req.params.deadlineId, changes));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/:deadlineId", async (req, res) => {
    if (!(await requireSubject(req, res))) return;
    try {
      await deleteDeadline(appDataDir, req.params.id, req.params.deadlineId);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
