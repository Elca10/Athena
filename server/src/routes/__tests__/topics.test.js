import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createSubject } from "../../subjects.js";
import { addPlannedTopics } from "../../topics.js";
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

test("GET /:id/topics/due for an unknown subject returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base("no-such-id")}/due`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("a newly added topic shows up in GET /:id/topics/due, then drops out after a review", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Biology" });
    await addPlannedTopics(dir, subject.id, ["Photosynthesis"]);
    const dueRes = await fetch(`${base(subject.id)}/due`);
    assert.equal(dueRes.status, 200);
    const due = await dueRes.json();
    assert.equal(due.length, 1);
    assert.equal(due[0].name, "Photosynthesis");

    const reviewRes = await fetch(`${base(subject.id)}/${due[0].id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: "good" }),
    });
    assert.equal(reviewRes.status, 200);
    const reviewed = await reviewRes.json();
    assert.ok(reviewed.fsrs.due > due[0].fsrs.due);

    assert.deepEqual(await (await fetch(`${base(subject.id)}/due`)).json(), []);
  } finally {
    server.close();
  }
});

test("POST /:id/topics/:topicId/review with an invalid rating returns 400 and changes nothing", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["The French Revolution"]);
    const res = await fetch(`${base(subject.id)}/${topic.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: "amazing" }),
    });
    assert.equal(res.status, 400);
    const stillDue = await (await fetch(`${base(subject.id)}/due`)).json();
    assert.deepEqual(stillDue[0].fsrs, topic.fsrs);
  } finally {
    server.close();
  }
});

test("POST /:id/topics/:topicId/review for an unknown topic id returns 404", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Art" });
    const res = await fetch(`${base(subject.id)}/no-such-topic/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: "good" }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
