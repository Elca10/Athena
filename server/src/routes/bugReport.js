import express from "express";
import { buildBugReportPreview, fileBugReportIssue } from "../bugReport.js";

// "Report a bug" (SPEC.md section 10/3.6): two steps, matching the UI's
// own preview-then-explicit-Send flow so the body actually filed can
// never diverge from the body the user approved — /send takes exactly the
// `{title, body}` /preview returned, rather than re-deriving it from the
// raw description a second time.
export function makeBugReportRouter(appDataDir) {
  const router = express.Router();

  router.post("/preview", async (req, res) => {
    try {
      const preview = await buildBugReportPreview(appDataDir, { description: req.body?.description });
      res.json(preview);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/send", async (req, res) => {
    const { title, body } = req.body ?? {};
    if (typeof title !== "string" || !title.trim() || typeof body !== "string" || !body.trim()) {
      res.status(400).json({ error: "A previewed title and body are required." });
      return;
    }
    const result = await fileBugReportIssue({ title, body });
    res.json(result);
  });

  return router;
}
