import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { makeSubjectsRouter } from "../subjects.js";

async function startApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-subjects-route-"));
  const app = express();
  app.use(express.json());
  app.use("/api/subjects", makeSubjectsRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/api/subjects`, server };
}

test("GET / then POST / then GET /:id round-trip over real HTTP", async () => {
  const { base, server } = await startApp();
  try {
    assert.deepEqual(await (await fetch(base)).json(), []);

    const createRes = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Discrete Math" }),
    });
    assert.equal(createRes.status, 201);
    const subject = await createRes.json();
    assert.equal(subject.name, "Discrete Math");

    const getRes = await fetch(`${base}/${subject.id}`);
    assert.equal(getRes.status, 200);
    assert.deepEqual(await getRes.json(), subject);
  } finally {
    server.close();
  }
});

test("POST / with no name returns 400 and creates nothing", async () => {
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

test("GET /:id for an unknown id returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /:id/archive then /:id/restore round-trips through the list endpoint", async () => {
  const { base, server } = await startApp();
  try {
    const subject = await (
      await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Art History" }),
      })
    ).json();

    const archiveRes = await fetch(`${base}/${subject.id}/archive`, { method: "POST" });
    assert.equal(archiveRes.status, 200);
    assert.equal((await archiveRes.json()).archived, true);
    assert.deepEqual(await (await fetch(base)).json(), []);
    assert.equal((await (await fetch(`${base}?includeArchived=true`)).json()).length, 1);

    const restoreRes = await fetch(`${base}/${subject.id}/restore`, { method: "POST" });
    assert.equal(restoreRes.status, 200);
    assert.equal((await restoreRes.json()).archived, false);
    assert.equal((await (await fetch(base)).json()).length, 1);
  } finally {
    server.close();
  }
});

test("POST /:id/archive for an unknown id returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/archive`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
