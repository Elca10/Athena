import express from "express";
import { listSubjects, getSubject, createSubject, archiveSubject, restoreSubject } from "../subjects.js";

export function makeSubjectsRouter(appDataDir) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    res.json(await listSubjects(appDataDir, { includeArchived }));
  });

  router.post("/", async (req, res) => {
    try {
      const subject = await createSubject(appDataDir, { name: req.body?.name });
      res.status(201).json(subject);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get("/:id", async (req, res) => {
    const subject = await getSubject(appDataDir, req.params.id);
    if (!subject) {
      res.status(404).json({ error: `Subject not found: ${req.params.id}` });
      return;
    }
    res.json(subject);
  });

  router.post("/:id/archive", async (req, res) => {
    try {
      res.json(await archiveSubject(appDataDir, req.params.id));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.post("/:id/restore", async (req, res) => {
    try {
      res.json(await restoreSubject(appDataDir, req.params.id));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  return router;
}
