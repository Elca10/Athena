import express from "express";
import { getSchedule, setAvailability, applyBlockAction, moveBlocks, BlockChangedError, BLOCK_ACTIONS } from "../schedule.js";

// Mounted at /api/schedule: the Calendar's suggested schedule (schedule.js)
// and the user's decisions about it. Every response that changes
// something returns the fresh schedule, so the UI never shows a stale one.
export function makeScheduleRouter(appDataDir) {
  const router = express.Router();

  router.get("/", async (_req, res) => {
    res.json(await getSchedule(appDataDir));
  });

  router.put("/availability", async (req, res) => {
    try {
      await setAvailability(appDataDir, req.body ?? {});
      res.json(await getSchedule(appDataDir));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Several blocks to one day in one go (issue #22). All or nothing.
  router.post("/blocks/move", async (req, res) => {
    try {
      res.json(await moveBlocks(appDataDir, req.body?.ids, req.body?.toDate));
    } catch (err) {
      if (err instanceof BlockChangedError) {
        res.status(409).json({ error: err.message, schedule: await getSchedule(appDataDir) });
        return;
      }
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/blocks/:blockId/:action", async (req, res) => {
    const { blockId, action } = req.params;
    if (!BLOCK_ACTIONS.includes(action)) {
      res.status(404).json({ error: `Unknown action: ${action}` });
      return;
    }
    try {
      res.json(await applyBlockAction(appDataDir, blockId, action, { toDate: req.body?.toDate }));
    } catch (err) {
      if (err instanceof BlockChangedError) {
        res.status(409).json({ error: err.message, schedule: await getSchedule(appDataDir) });
        return;
      }
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
