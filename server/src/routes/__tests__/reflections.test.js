import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createSubject } from "../../subjects.js";
import { createSession, promptReflection } from "../../sessions.js";
import { submitSessionReflection } from "../../reflection.js";
import { makeReflectionsRouter } from "../reflections.js";
import { makeTempDir } from "../../testHelpers/tempDir.js";

async function startApp() {
  const dir = await makeTempDir("athena-reflections-route-");
  const app = express();
  app.use(express.json());
  app.use("/api/subjects/:id/reflections", makeReflectionsRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { dir, base: (id) => `http://127.0.0.1:${port}/api/subjects/${id}/reflections`, server };
}

test("GET /:id/reflections for an unknown subject returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(base("no-such-id"));
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("GET /:id/reflections starts empty for a real subject", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Chemistry" });
    assert.deepEqual(await (await fetch(base(subject.id))).json(), []);
  } finally {
    server.close();
  }
});

test("GET /:id/reflections returns reflections tagged with that subject, in storage order", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subjectA = await createSubject(dir, { name: "Chemistry" });
    const subjectB = await createSubject(dir, { name: "Physics" });

    const session1 = await createSession(dir, { subjectIds: [subjectA.id], mode: "live" });
    await promptReflection(dir, session1.id);
    const { reflection: r1 } = await submitSessionReflection(dir, session1.id, { learned: "Bonds" });

    const session2 = await createSession(dir, { subjectIds: [subjectA.id, subjectB.id], mode: "ready" });
    await promptReflection(dir, session2.id);
    const { reflection: r2 } = await submitSessionReflection(dir, session2.id, { learned: "Forces" });

    assert.deepEqual(await (await fetch(base(subjectA.id))).json(), [r1, r2]);
    assert.deepEqual(await (await fetch(base(subjectB.id))).json(), [r2]);
  } finally {
    server.close();
  }
});
