import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { makeStatsRouter } from "../stats.js";

async function startApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-stats-route-"));
  const app = express();
  app.use(express.json());
  app.use("/api/stats", makeStatsRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/api/stats`, server };
}

test("GET /sessions returns zeroed/null stats for a fresh app-data dir", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/sessions`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      sessionsThisWeek: 0,
      questionsThisWeek: 0,
      streakDays: 0,
      accuracy: { correct: 0, total: 0, rate: null },
      calibration: {
        byConfidence: [1, 2, 3, 4, 5].map((confidence) => ({ confidence, total: 0, correctRate: null })),
      },
    });
  } finally {
    server.close();
  }
});
