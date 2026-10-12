import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeGhOnPath } from "./fakeGhOnPath.js";

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

test("GET /api/setup/os reports a real detected OS (windows, mac, or other)", async () => {
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/setup/os`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(["windows", "mac", "other"].includes(body.detected));
  } finally {
    server.close();
  }
});

test("POST /api/bug-report/preview rejects an empty description", async () => {
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bug-report/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "   " }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /api/bug-report/preview then /send files through a fake gh and returns the issue URL", async () => {
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();

  // runCommand (processUtil.js) inherits process.env when no `env` is
  // passed, and the route layer never exposes an env override (on
  // purpose — only this test file's own env, not a production code
  // path, needs to point `gh` at a fake). Save/restore so no other test
  // in this process sees the fake PATH.
  const fake = await fakeGhOnPath({ mode: "success", url: "https://github.com/Elca10/Athena/issues/999" });
  const savedEnv = { ...process.env };
  Object.assign(process.env, fake.env);

  try {
    const previewRes = await fetch(`http://127.0.0.1:${port}/api/bug-report/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "the Ready session hangs after I answer" }),
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    assert.ok(preview.title.startsWith("Bug report: "));
    assert.match(preview.body, /the Ready session hangs after I answer/);

    const sendRes = await fetch(`http://127.0.0.1:${port}/api/bug-report/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preview),
    });
    assert.equal(sendRes.status, 200);
    const sendBody = await sendRes.json();
    assert.deepEqual(sendBody, { ok: true, url: "https://github.com/Elca10/Athena/issues/999" });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    server.close();
  }
});

test("POST /api/bug-report/send rejects a request with no previewed title/body", async () => {
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bug-report/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
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
