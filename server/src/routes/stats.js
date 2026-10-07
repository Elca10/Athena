import express from "express";
import { getSessionStats } from "../sessionStats.js";

export function makeStatsRouter(appDataDir) {
  const router = express.Router();

  router.get("/sessions", async (req, res) => {
    res.json(await getSessionStats(appDataDir));
  });

  return router;
}
