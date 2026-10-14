import express from "express";
import { readLastUpdate } from "../updateApply.js";

// GET /api/update/status: the last check's result plus what the UI needs
// for the button: whether an update is underway, why it can't start right
// now (if it can't), and how the last update went. Cheap, no git call.
// POST /api/update/check: check now ("Check for updates").
// POST /api/update/apply: start the update (updateApply.js); 409 with a
// plain reason when it won't.
export function makeUpdateRouter(updateChecker, { applier, appDataDir } = {}) {
  const router = express.Router();

  router.get("/status", async (_req, res) => {
    res.json({
      ...updateChecker.getStatus(),
      updating: applier?.isDraining() ?? false,
      blockedReason: applier?.blockedReason() ?? null,
      lastUpdate: appDataDir ? await readLastUpdate(appDataDir) : null,
    });
  });

  router.post("/check", async (_req, res) => {
    res.json(await updateChecker.checkNow());
  });

  router.post("/apply", async (_req, res) => {
    if (!applier) {
      res.status(404).json({ error: "Updating isn't available here." });
      return;
    }
    const result = await applier.apply();
    if (!result.ok) {
      res.status(409).json({ error: result.reason });
      return;
    }
    res.status(202).json({ updating: true, from: result.from, to: result.to });
  });

  return router;
}
