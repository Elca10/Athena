import express from "express";
import { getSessionStats } from "../sessionStats.js";
import { checkUsageNow } from "../usageStatus.js";

export function makeStatsRouter(appDataDir) {
  const router = express.Router();

  router.get("/sessions", async (req, res) => {
    res.json(await getSessionStats(appDataDir));
  });

  // Runs a live `/usage` check on every request rather than serving a
  // cached value on a timer -- see usageStatus.js's module docstring for
  // why that's free (no inference round-trip) and never throws (a CLI
  // failure or unparseable reply comes back as `{..., error: "..."}`,
  // not a 500).
  router.get("/usage", async (req, res) => {
    res.json(await checkUsageNow(appDataDir));
  });

  return router;
}
