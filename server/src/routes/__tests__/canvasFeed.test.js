import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { makeTempDir } from "../../testHelpers/tempDir.js";
import { makeCanvasFeedRouter } from "../canvasFeed.js";
import { makeDeadlinesRouter } from "../deadlines.js";
import { createSubject } from "../../subjects.js";

const FEED_URL = "https://school.instructure.com/feeds/calendars/user_SECRETtoken123.ics";
const FEED =
  "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:exam\r\nDTSTART;VALUE=DATE:20991105\r\nSUMMARY:Midterm [Biology]\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

async function startApp(fetchImpl) {
  const dir = await makeTempDir("athena-canvas-route-");
  const app = express();
  app.use(express.json());
  app.use("/api/canvas-feed", makeCanvasFeedRouter(dir, { fetchImpl }));
  app.use("/api/subjects/:id/deadlines", makeDeadlinesRouter(dir));
  const server = app.listen(0);
  return { dir, base: `http://127.0.0.1:${server.address().port}/api`, server };
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("canvas feed over HTTP: connect, list, import, forget — the URL never comes back", async () => {
  const { dir, base, server } = await startApp(async () => new Response(FEED));
  try {
    const subject = await createSubject(dir, { name: "Biology" });

    let res = await fetch(`${base}/canvas-feed/events`);
    assert.equal(res.status, 409);

    res = await fetch(`${base}/canvas-feed`, json("PUT", { url: "https://example.com/not-a-feed" }));
    assert.equal(res.status, 400);

    res = await fetch(`${base}/canvas-feed`, json("PUT", { url: FEED_URL }));
    assert.equal(res.status, 200);
    const statusText = await res.text();
    assert.ok(!statusText.includes("SECRET"));
    assert.deepEqual(JSON.parse(statusText), { connected: true, host: "school.instructure.com" });

    res = await fetch(`${base}/canvas-feed/events`);
    const eventsText = await res.text();
    assert.ok(!eventsText.includes("SECRET"));
    const events = JSON.parse(eventsText);
    assert.equal(events.length, 1);
    assert.equal(events[0].suggestedSubjectId, subject.id);

    res = await fetch(`${base}/canvas-feed/import`, json("POST", { subjectId: subject.id, uids: ["exam"] }));
    assert.equal(res.status, 201);
    const { added } = await res.json();
    assert.equal(added[0].source, "canvas");

    res = await fetch(`${base}/canvas-feed`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.deepEqual(await (await fetch(`${base}/canvas-feed`)).json(), { connected: false, host: null });
  } finally {
    server.close();
  }
});

test("a deadline's source and externalId can't be set over the deadlines route", async () => {
  const { dir, base, server } = await startApp(async () => new Response(FEED));
  try {
    const subject = await createSubject(dir, { name: "Biology" });
    const res = await fetch(
      `${base}/subjects/${subject.id}/deadlines`,
      json("POST", { title: "Exam", date: "2099-01-01", source: "canvas", externalId: "exam" }),
    );
    const created = await res.json();
    assert.equal(created.source, "manual");
    assert.equal(created.externalId, undefined);
  } finally {
    server.close();
  }
});

test("a Canvas outage is a 502 with a plain message, not a 500", async () => {
  let fail = false;
  const { base, server } = await startApp(async () => (fail ? new Response("", { status: 503 }) : new Response(FEED)));
  try {
    await fetch(`${base}/canvas-feed`, json("PUT", { url: FEED_URL }));
    fail = true;
    const res = await fetch(`${base}/canvas-feed/events`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /HTTP 503/);
  } finally {
    server.close();
  }
});
