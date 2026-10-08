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

// Deliberately not asserting exact values -- this calls the real `claude`
// CLI if one is on PATH (same posture as topics.js's own `/scan` route,
// which also has no DI seam through the router), and whether that CLI is
// installed/logged in varies by machine. `/usage` is confirmed free either
// way (usageStatus.js's module docstring), and checkUsageNow never throws,
// so the one thing this test can assert everywhere is the response shape:
// a 200 with either a real reading or a graceful `error` string, never a
// crash.
test("GET /usage returns 200 with the shape checkUsageNow always produces", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/usage`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.checkedAt, "number");
    assert.ok(body.fiveHour === null || typeof body.fiveHour === "object");
    assert.ok(body.weekly === null || typeof body.weekly === "object");
    assert.ok(body.error === null || typeof body.error === "string");
  } finally {
    server.close();
  }
});
