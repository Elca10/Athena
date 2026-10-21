import express from "express";
import { getSettings, updateSettings } from "../settings.js";

export function makeSettingsRouter(appDataDir) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    res.json(await getSettings(appDataDir));
  });

  router.patch("/", async (req, res) => {
    try {
      res.json(await updateSettings(appDataDir, req.body ?? {}));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
