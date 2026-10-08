import express from "express";
import { listPreferences, addPreference, deletePreference } from "../preferences.js";

export function makePreferencesRouter(appDataDir) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    res.json(await listPreferences(appDataDir));
  });

  router.post("/", async (req, res) => {
    try {
      const preference = await addPreference(appDataDir, { text: req.body?.text });
      res.status(201).json(preference);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      await deletePreference(appDataDir, req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  return router;
}
