import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createSubject } from "../../subjects.js";
import { createSession, endSession } from "../../sessions.js";
import { addPlannedTopics } from "../../topics.js";
import { makeSessionsRouter } from "../sessions.js";

async function startApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-sessions-route-"));
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", makeSessionsRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { dir, base: `http://127.0.0.1:${port}/api/sessions`, server };
}

test("GET /api/sessions starts empty", async () => {
  const { base, server } = await startApp();
  try {
    assert.deepEqual(await (await fetch(base)).json(), []);
  } finally {
    server.close();
  }
});

test("POST /api/sessions creates a session for a real subject", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Chemistry" });
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "live" }),
    });
    assert.equal(res.status, 201);
    const session = await res.json();
    assert.deepEqual(session.subjectIds, [subject.id]);
    assert.equal(session.status, "active");
    assert.deepEqual(await (await fetch(base)).json(), [session]);
  } finally {
    server.close();
  }
});

test("POST /api/sessions auto-builds topicIds from the subject's due topics when none are given", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Biology" });
    const added = await addPlannedTopics(dir, subject.id, ["Mitosis", "Meiosis"]);
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "live" }),
    });
    assert.equal(res.status, 201);
    const session = await res.json();
    assert.deepEqual(session.topicIds.sort(), added.map((t) => t.id).sort());
  } finally {
    server.close();
  }
});

test("POST /api/sessions keeps an explicitly-given topicIds instead of auto-building", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Geology" });
    await addPlannedTopics(dir, subject.id, ["Plate tectonics", "Rock cycle"]);
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "live", topicIds: ["explicit-topic"] }),
    });
    assert.equal(res.status, 201);
    const session = await res.json();
    assert.deepEqual(session.topicIds, ["explicit-topic"]);
  } finally {
    server.close();
  }
});

test("POST /api/sessions with an unknown subject id returns 400", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: ["no-such-subject"], mode: "live" }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await (await fetch(base)).json(), []);
  } finally {
    server.close();
  }
});

test("POST /api/sessions with an unknown mode returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Physics" });
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "turbo" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("GET /api/sessions/:id for an unknown id returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("GET /api/sessions/:id finds a real session", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "ready" });
    const res = await fetch(`${base}/${session.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), session);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/status moves between active and waiting", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
    const res = await fetch(`${base}/${session.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "waiting" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "waiting");
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/status with an invalid status returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
    const res = await fetch(`${base}/${session.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/status for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "waiting" }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/status refuses to reopen a completed session (400)", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
    await endSession(dir, session.id);
    const res = await fetch(`${base}/${session.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/end marks a session completed", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
    const res = await fetch(`${base}/${session.id}/end`, { method: "POST" });
    assert.equal(res.status, 200);
    const ended = await res.json();
    assert.equal(ended.status, "completed");
    assert.equal(typeof ended.endedAt, "string");
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/end for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/end`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/archive then /restore round-trips", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
    const archiveRes = await fetch(`${base}/${session.id}/archive`, { method: "POST" });
    assert.equal(archiveRes.status, 200);
    assert.equal((await archiveRes.json()).archived, true);
    assert.deepEqual(await (await fetch(base)).json(), []);

    const restoreRes = await fetch(`${base}/${session.id}/restore`, { method: "POST" });
    assert.equal(restoreRes.status, 200);
    assert.equal((await restoreRes.json()).archived, false);
    const list = await (await fetch(base)).json();
    assert.equal(list.length, 1);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/archive for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/archive`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
