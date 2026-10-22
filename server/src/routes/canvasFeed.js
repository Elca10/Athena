import express from "express";
import { FeedError, forgetFeed, getFeedStatus, importFeedEvents, listFeedEvents, saveFeedUrl } from "../canvasFeed.js";

// Mounted at /api/canvas-feed. A FeedError's message is user-facing and
// never contains the feed URL, so it's safe to return as-is; anything
// else falls through to the generic 500 handler.
export function makeCanvasFeedRouter(appDataDir, { fetchImpl } = {}) {
  const router = express.Router();

  function handle(fn) {
    return async (req, res, next) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof FeedError) res.status(err.status).json({ error: err.message });
        else next(err);
      }
    };
  }

  router.get("/", handle(async (_req, res) => res.json(await getFeedStatus(appDataDir))));

  router.put(
    "/",
    handle(async (req, res) => res.json(await saveFeedUrl(appDataDir, req.body?.url, { fetchImpl }))),
  );

  router.delete(
    "/",
    handle(async (_req, res) => {
      await forgetFeed(appDataDir);
      res.status(204).end();
    }),
  );

  router.get("/events", handle(async (_req, res) => res.json(await listFeedEvents(appDataDir, { fetchImpl }))));

  router.post(
    "/import",
    handle(async (req, res) => {
      const { subjectId, uids } = req.body ?? {};
      res.status(201).json(await importFeedEvents(appDataDir, { subjectId, uids }, { fetchImpl }));
    }),
  );

  return router;
}
