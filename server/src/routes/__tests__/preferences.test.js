import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { makePreferencesRouter } from "../preferences.js";

async function startApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-preferences-route-"));
  const app = express();
  app.use(express.json());
  app.use("/api/preferences", makePreferencesRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/api/preferences`, server };
}

test("GET / then POST / then GET / round-trip over real HTTP", async () => {
  const { base, server } = await startApp();
  try {
    assert.deepEqual(await (await fetch(base)).json(), []);

    const createRes = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "always give a worked example after a miss" }),
    });
    assert.equal(createRes.status, 201);
    const preference = await createRes.json();
    assert.equal(preference.text, "always give a worked example after a miss");

    assert.deepEqual(await (await fetch(base)).json(), [preference]);
  } finally {
    server.close();
  }
});

test("POST / with no text returns 400 and creates nothing", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await (await fetch(base)).json(), []);
  } finally {
    server.close();
  }
});

test("DELETE /:id removes the preference", async () => {
  const { base, server } = await startApp();
  try {
    const preference = await (
      await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "harder questions on proofs" }),
      })
    ).json();

    const deleteRes = await fetch(`${base}/${preference.id}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 204);
    assert.deepEqual(await (await fetch(base)).json(), []);
  } finally {
    server.close();
  }
});

test("DELETE /:id for an unknown id returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id`, { method: "DELETE" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
