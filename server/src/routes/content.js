import express from "express";
import { getSubject } from "../subjects.js";
import { listContent, addUploadedContent, addPastedNotes } from "../content.js";

// Mounted at /api/subjects/:id/content — needs mergeParams so the :id
// from the parent mount point reaches this router's own handlers.
export function makeContentRouter(appDataDir) {
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
    res.json(await listContent(appDataDir, req.params.id));
  });

  router.post("/", async (req, res) => {
    if (!(await requireSubject(req, res))) return;
    try {
      const record = await addUploadedContent(appDataDir, req.params.id, {
        filename: req.body?.filename,
        text: req.body?.text,
      });
      res.status(201).json(record);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/notes", async (req, res) => {
    if (!(await requireSubject(req, res))) return;
    try {
      const record = await addPastedNotes(appDataDir, req.params.id, { text: req.body?.text });
      res.status(201).json(record);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
