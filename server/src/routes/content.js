import express from "express";
import { getSubject } from "../subjects.js";
import { listContent, addUploadedContent, addPastedNotes, removeContent, MAX_BINARY_CONTENT_BYTES } from "../content.js";

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

  // Binary uploads (PDF/PPTX) arrive as the raw file bytes, with the
  // filename in the query string. They used to be base64 inside a JSON
  // body, which inflated every file by a third and hit the JSON size
  // limit on big slide decks (issue #6). The raw parser is scoped to this
  // route only; a body over the limit becomes a plain 413 in index.js.
  router.post(
    "/file",
    express.raw({ type: "application/octet-stream", limit: MAX_BINARY_CONTENT_BYTES + 1024 }),
    async (req, res) => {
      if (!(await requireSubject(req, res))) return;
      try {
        const record = await addUploadedContent(appDataDir, req.params.id, {
          filename: typeof req.query.filename === "string" ? req.query.filename : undefined,
          fileBuffer: Buffer.isBuffer(req.body) ? req.body : undefined,
        });
        res.status(201).json(record);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },
  );

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
