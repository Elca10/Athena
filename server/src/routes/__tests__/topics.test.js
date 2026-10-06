import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createSubject } from "../../subjects.js";
import { makeTopicsRouter } from "../topics.js";

async function startApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-topics-route-"));
  const app = express();
  app.use(express.json());
  app.use("/api/subjects/:id/topics", makeTopicsRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { dir, base: (id) => `http://127.0.0.1:${port}/api/subjects/${id}/topics`, server };
}

test("GET /:id/topics for an unknown subject returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(base("no-such-id"));
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("GET /:id/topics starts empty for a real subject", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Chemistry" });
    assert.deepEqual(await (await fetch(base(subject.id))).json(), []);
  } finally {
    server.close();
  }
});

test("POST /:id/topics/scan for an unknown subject returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base("no-such-id")}/scan`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /:id/topics/scan with no content does nothing and GET reflects it", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Physics" });
    const res = await fetch(`${base(subject.id)}/scan`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, skipped: false, topicsAdded: 0, filesProcessed: 0, errors: [] });
    assert.deepEqual(await (await fetch(base(subject.id))).json(), []);
  } finally {
    server.close();
  }
});
