import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "../../testHelpers/tempDir.js";
import express from "express";
import { makeSubjectsRouter } from "../subjects.js";
import { makeDeadlinesRouter } from "../deadlines.js";
import { makeScheduleRouter } from "../schedule.js";
import { createSubject } from "../../subjects.js";
import { addPlannedTopics } from "../../topics.js";
import { localDateOf, addDays } from "../../localDate.js";

async function startApp() {
  const dir = await makeTempDir("athena-deadlines-route-");
  const app = express();
  app.use(express.json());
  app.use("/api/subjects", makeSubjectsRouter(dir));
  app.use("/api/subjects/:id/deadlines", makeDeadlinesRouter(dir));
  app.use("/api/schedule", makeScheduleRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { dir, base: `http://127.0.0.1:${port}/api`, server };
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("deadlines CRUD over HTTP, with the next deadline on the subject's summary", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Biology" });
    const [cells] = await addPlannedTopics(dir, subject.id, ["Cells"]);
    const url = `${base}/subjects/${subject.id}/deadlines`;
    assert.deepEqual(await (await fetch(url)).json(), []);

    const date = addDays(localDateOf(), 10);
    const created = await fetch(url, json("POST", { title: "Midterm", date, topicIds: [cells.id] }));
    assert.equal(created.status, 201);
    const deadline = await created.json();
    assert.equal(deadline.studying, true);

    const summary = await (await fetch(`${base}/subjects/${subject.id}/summary`)).json();
    assert.deepEqual(summary.nextDeadline, { id: deadline.id, title: "Midterm", date, studying: true });

    const patched = await fetch(`${url}/${deadline.id}`, json("PATCH", { studying: false, id: "hijack", subjectId: "other" }));
    assert.equal(patched.status, 200);
    const updated = await patched.json();
    assert.equal(updated.studying, false);
    assert.equal(updated.id, deadline.id, "only editable fields are taken from the body");
    assert.equal(updated.subjectId, subject.id);

    const deleted = await fetch(`${url}/${deadline.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    assert.deepEqual(await (await fetch(url)).json(), []);
  } finally {
    server.close();
  }
});

test("bad deadline input is a 400 with a reason; unknown subject or deadline is a 404", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Biology" });
    const url = `${base}/subjects/${subject.id}/deadlines`;
    const bad = await fetch(url, json("POST", { title: "Quiz", date: "2026-02-30" }));
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /valid date/);
    assert.equal((await fetch(`${base}/subjects/nope/deadlines`)).status, 404);
    assert.equal((await fetch(`${url}/nope`, json("PATCH", { title: "x" }))).status, 404);
    assert.equal((await fetch(`${url}/nope`, { method: "DELETE" })).status, 404);
  } finally {
    server.close();
  }
});

test("schedule over HTTP: GET, availability, block actions, and a 409 with the fresh schedule for a stale block", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Biology" });
    await addPlannedTopics(dir, subject.id, ["Cells"]);
    const schedule = await (await fetch(`${base}/schedule`)).json();
    assert.equal(schedule.days.length, 14);
    const [block] = schedule.days[0].blocks;
    assert.equal(block.topicName, "Cells", "a brand-new topic is due today");

    const badAvailability = await fetch(`${base}/schedule/availability`, json("PUT", { weekdays: [1], minutesPerDay: 0 }));
    assert.equal(badAvailability.status, 400);
    const okAvailability = await fetch(`${base}/schedule/availability`, json("PUT", { weekdays: [0, 1, 2, 3, 4, 5, 6], minutesPerDay: 45 }));
    assert.equal(okAvailability.status, 200);
    assert.equal((await okAvailability.json()).availability.minutesPerDay, 45);

    const tomorrow = addDays(schedule.today, 1);
    const moved = await fetch(`${base}/schedule/blocks/${encodeURIComponent(block.id)}/move`, json("POST", { toDate: tomorrow }));
    assert.equal(moved.status, 200);
    assert.deepEqual((await moved.json()).days[1].blocks.map((b) => [b.id, b.moved]), [[block.id, true]]);

    const badMove = await fetch(`${base}/schedule/blocks/${encodeURIComponent(block.id)}/move`, json("POST", { toDate: "1999-01-01" }));
    assert.equal(badMove.status, 400);

    const stale = await fetch(`${base}/schedule/blocks/${encodeURIComponent(`${schedule.today}:nope`)}/done`, json("POST", {}));
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.match(staleBody.error, /isn't on your schedule/);
    assert.equal(staleBody.schedule.days.length, 14);

    assert.equal((await fetch(`${base}/schedule/blocks/${encodeURIComponent(block.id)}/explode`, json("POST", {}))).status, 404);
  } finally {
    server.close();
  }
});
