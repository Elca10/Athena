import express from "express";

// GET /api/update/status: the last check's result, cheap (no git call).
// POST /api/update/check: check now ("Check for updates" in the UI).
export function makeUpdateRouter(updateChecker) {
  const router = express.Router();

  router.get("/status", (_req, res) => {
    res.json(updateChecker.getStatus());
  });

  router.post("/check", async (_req, res) => {
    res.json(await updateChecker.checkNow());
  });

  return router;
}
