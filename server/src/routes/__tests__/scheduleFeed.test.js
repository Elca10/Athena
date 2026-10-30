// GET /api/schedule/feed.ics through the real router and the loopback
// guard: a calendar app on this computer gets the same plan the Calendar
// shows; a request naming another host is refused like any other API call.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { makeTempDir } from "../../testHelpers/tempDir.js";
import { appDataSubdirs } from "../../dataDir.js";
import { makeJsonFileStore } from "../../store/jsonFileStore.js";
import { createSubject } from "../../subjects.js";
import { localDateOf } from "../../localDate.js";
import { localOnly } from "../../localOnly.js";
import { makeScheduleRouter } from "../schedule.js";

async function startApp() {
  const dir = await makeTempDir("athena-schedule-feed-route-");
  const subject = await createSubject(dir, { name: "Biology" });
  await makeJsonFileStore(appDataSubdirs(dir).db, "topics.json", []).write([
    { id: "t1", subjectId: subject.id, name: "Cell membranes", fsrs: { due: Date.now() - 86400000 }, createdAt: "x", notes: "", bankGeneratedAt: null },
  ]);
  const app = express();
  app.use(localOnly);
  app.use("/api/schedule", makeScheduleRouter(dir));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return { port, server };
}

test("feed.ics serves today's overdue topic as a calendar event", async () => {
  const { port, server } = await startApp();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/schedule/feed.ics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/calendar/);
    const body = await res.text();
    const today = localDateOf(new Date());
    assert.ok(body.includes(`UID:${today}@athena-studying`));
    assert.ok(body.includes(`DTSTART;VALUE=DATE:${today.replaceAll("-", "")}`));
    assert.ok(body.includes("Biology: Cell membranes"));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("feed.ics refuses a request that names another host", async () => {
  const { port, server } = await startApp();
  try {
    // fetch() won't send a custom Host header; a raw request can.
    const status = await new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/api/schedule/feed.ics", headers: { Host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on("error", reject);
    });
    assert.equal(status, 403);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
