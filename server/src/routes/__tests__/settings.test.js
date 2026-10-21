import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { makeSettingsRouter } from "../settings.js";

async function startApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-settings-route-"));
  const app = express();
  app.use(express.json());
  app.use("/api/settings", makeSettingsRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/api/settings`, server };
}

test("GET / defaults bigIdeasPromptEnabled to false", async () => {
  const { base, server } = await startApp();
  try {
    assert.deepEqual(await (await fetch(base)).json(), { bigIdeasPromptEnabled: false });
  } finally {
    server.close();
  }
});

test("PATCH / then GET / round-trips the change", async () => {
  const { base, server } = await startApp();
  try {
    const patchRes = await fetch(base, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bigIdeasPromptEnabled: true }),
    });
    assert.equal(patchRes.status, 200);
    assert.deepEqual(await patchRes.json(), { bigIdeasPromptEnabled: true });
    assert.deepEqual(await (await fetch(base)).json(), { bigIdeasPromptEnabled: true });
  } finally {
    server.close();
  }
});

test("PATCH / with an unknown key returns 400 and changes nothing", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(base, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notReal: true }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await (await fetch(base)).json(), { bigIdeasPromptEnabled: false });
  } finally {
    server.close();
  }
});
