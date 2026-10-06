import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Scratch, collision-proof data dir for every test in this file — must be
// set before createApp() runs (though dataDir.js itself re-reads
// process.env on every call rather than caching at import time, so there's
// no module-load-order hazard here — isolating real test runs from a real
// user's app-data dir is still the point).
let scratchDir;

test.before(async () => {
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-index-test-"));
  process.env.ATHENA_DATA_DIR = scratchDir;
});

test.after(() => {
  delete process.env.ATHENA_DATA_DIR;
});

test("GET /api/health reports ok and an unset-up app", async () => {
  const { createApp } = await import("../index.js");
  const { app, appDataDir } = await createApp();
  assert.equal(appDataDir, scratchDir);

  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.setupComplete, false);
    assert.equal(typeof body.version, "string");
  } finally {
    server.close();
  }
});

test("POST /api/setup/complete then GET /api/health reflects setupComplete:true", async () => {
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const postRes = await fetch(`http://127.0.0.1:${port}/api/setup/complete`, { method: "POST" });
    assert.equal(postRes.status, 200);

    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await healthRes.json();
    assert.equal(body.setupComplete, true);
  } finally {
    server.close();
  }
});
