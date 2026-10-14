import express from "express";
import { getSubject } from "../subjects.js";
import { listContent, addUploadedContent, addPastedNotes, removeContent } from "../content.js";

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
        // Binary uploads (currently PDF/PPTX) arrive base64-encoded in the
        // JSON body rather than multipart/form-data — the frontend reads
        // the file and encodes it client-side (AddContentPanel.tsx), which
        // keeps this route's shape uniform with the plain-text path and
        // avoids a multipart-parsing dependency for one file field.
        contentBase64: req.body?.contentBase64,
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

  router.delete("/:contentId", async (req, res) => {
    const removed = await removeContent(appDataDir, req.params.id, req.params.contentId);
    if (!removed) {
      res.status(404).json({ error: "That content item wasn't found." });
      return;
    }
    res.json({ removed: removed.id });
  });

  return router;
}
