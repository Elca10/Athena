import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  FeedError,
  MAX_FEED_BYTES,
  fetchFeedText,
  forgetFeed,
  getFeedStatus,
  importFeedEvents,
  listFeedEvents,
  parseIcs,
  saveFeedUrl,
  suggestSubjectId,
  validateFeedUrl,
} from "../canvasFeed.js";
import { createSubject } from "../subjects.js";
import { listDeadlines, updateDeadline } from "../deadlines.js";
import { appDataSubdirs } from "../dataDir.js";
import { localDateOf } from "../localDate.js";
import { makeTempDir } from "../testHelpers/tempDir.js";

const FEED_URL = "https://school.instructure.com/feeds/calendars/user_SECRETtoken123.ics";

function ics(events) {
  const body = events
    .map(
      (e) =>
        `BEGIN:VEVENT\r\nUID:${e.uid}\r\nDTSTART${e.dtstart.startsWith(";") ? "" : ":"}${e.dtstart}\r\nSUMMARY:${e.summary}\r\nEND:VEVENT`,
    )
    .join("\r\n");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Instructure//Canvas\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

function fakeFetch(text, { status = 200, url } = {}) {
  const calls = [];
  const impl = async (requested) => {
    calls.push(requested);
    const res = new Response(text, { status });
    if (url) Object.defineProperty(res, "url", { value: url });
    return res;
  };
  impl.calls = calls;
  return impl;
}

async function rejectsFeedError(promise, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof FeedError, `expected FeedError, got ${err}`);
    assert.match(err.message, pattern);
    assert.ok(!err.message.includes("SECRET"), "message must never contain the feed URL");
    return true;
  });
}

test("validateFeedUrl accepts Canvas feed links (and webcal://) and rejects anything else", () => {
  assert.equal(validateFeedUrl(`  ${FEED_URL}  `), FEED_URL);
  assert.equal(validateFeedUrl(FEED_URL.replace("https://", "webcal://")), FEED_URL);
  assert.equal(validateFeedUrl("https://canvas.uni.edu/feeds/calendars/user_abc.ics#x"), "https://canvas.uni.edu/feeds/calendars/user_abc.ics");
  for (const bad of [
    "",
    null,
    "not a url",
    FEED_URL.replace("https://", "http://"),
    "https://school.instructure.com/calendar",
    "https://127.0.0.1/admin",
    Object.assign(new URL(FEED_URL), { username: "u", password: "p" }).toString(),
    "file:///etc/feeds/calendars/user_x.ics",
  ]) {
    assert.throws(() => validateFeedUrl(bad), FeedError, String(bad));
  }
});

test("parseIcs reads UID, title, course and a local date; unfolds lines and unescapes text", () => {
  const text =
    "BEGIN:VCALENDAR\r\n" +
    "BEGIN:VEVENT\r\nUID:event-assignment-1\r\nDTSTART;VALUE=DATE:20261030\r\n" +
    "SUMMARY:Lab report\\, part 2\; final [BIO 101 - Fall]\r\nEND:VEVENT\r\n" +
    "BEGIN:VEVENT\r\nUID:event-assignment-2\r\nDTSTART:20261031T035900Z\r\n" +
    "SUMMARY:A very long title that Canvas folded\r\n  across two lines [CSC 4553]\r\nEND:VEVENT\r\n" +
    "BEGIN:VEVENT\r\nUID:event-calendar-event-3\r\nDTSTART;TZID=\"America/New_York\":20261105T090000\r\n" +
    "SUMMARY:Midterm\r\nEND:VEVENT\r\n" +
    "BEGIN:VEVENT\r\nSUMMARY:No UID, skipped\r\nDTSTART:20261101\r\nEND:VEVENT\r\n" +
    "BEGIN:VEVENT\r\nUID:no-date\r\nSUMMARY:No date, skipped\r\nEND:VEVENT\r\n" +
    "END:VCALENDAR\r\n";
  assert.deepEqual(parseIcs(text), [
    { uid: "event-assignment-1", title: "Lab report, part 2; final", course: "BIO 101 - Fall", date: "2026-10-30" },
    {
      uid: "event-assignment-2",
      title: "A very long title that Canvas folded across two lines",
      course: "CSC 4553",
      // A UTC due time lands on the user's own local day.
      date: localDateOf(new Date(Date.UTC(2026, 9, 31, 3, 59))),
    },
    { uid: "event-calendar-event-3", title: "Midterm", course: null, date: "2026-11-05" },
  ]);
});

test("parseIcs survives junk and gives an untitled event a placeholder title", () => {
  assert.deepEqual(parseIcs("garbage\nmore garbage"), []);
  assert.deepEqual(parseIcs(ics([{ uid: "u", dtstart: "20261030", summary: "" }])), [
    { uid: "u", title: "Untitled Canvas event", course: null, date: "2026-10-30" },
  ]);
});

test("suggestSubjectId only suggests when exactly one subject's name is in the course", () => {
  const subjects = [
    { id: "a", name: "CSC 4553" },
    { id: "b", name: "Biology" },
    { id: "c", name: "Bio" },
  ];
  assert.equal(suggestSubjectId("CSC4553 - Machine Learning", subjects), "a");
  assert.equal(suggestSubjectId("Biology 101", subjects), null); // "Biology" and "Bio" both match
  assert.equal(suggestSubjectId("History", subjects), null);
  assert.equal(suggestSubjectId(null, subjects), null);
});

test("fetchFeedText turns every failure into a FeedError that never names the URL", async () => {
  const cal = ics([]);
  assert.equal(await fetchFeedText(FEED_URL, { fetchImpl: fakeFetch(cal) }), cal);
  await rejectsFeedError(fetchFeedText(FEED_URL, { fetchImpl: fakeFetch("", { status: 404 }) }), /didn't recognize/);
  await rejectsFeedError(fetchFeedText(FEED_URL, { fetchImpl: fakeFetch("", { status: 500 }) }), /HTTP 500/);
  await rejectsFeedError(
    fetchFeedText(FEED_URL, {
      fetchImpl: async () => {
        throw new Error(`getaddrinfo ENOTFOUND ${FEED_URL}`);
      },
    }),
    /Couldn't reach Canvas/,
  );
  await rejectsFeedError(fetchFeedText(FEED_URL, { fetchImpl: fakeFetch("<html>login</html>") }), /didn't return a calendar/);
  await rejectsFeedError(fetchFeedText(FEED_URL, { fetchImpl: fakeFetch(cal, { url: "http://evil.example/x.ics" }) }), /insecure/);
  await rejectsFeedError(
    fetchFeedText(FEED_URL, { fetchImpl: fakeFetch("BEGIN:VCALENDAR\n" + "x".repeat(MAX_FEED_BYTES + 1)) }),
    /too big/,
  );
});

test("saveFeedUrl checks the feed before storing it; status shows the host, never the URL", async () => {
  const dir = await makeTempDir("athena-canvas-feed-");
  assert.deepEqual(await getFeedStatus(dir), { connected: false, host: null });

  await rejectsFeedError(saveFeedUrl(dir, FEED_URL, { fetchImpl: fakeFetch("", { status: 404 }) }), /didn't recognize/);
  assert.deepEqual(await getFeedStatus(dir), { connected: false, host: null });

  const status = await saveFeedUrl(dir, FEED_URL, { fetchImpl: fakeFetch(ics([])) });
  assert.deepEqual(status, { connected: true, host: "school.instructure.com" });
  const stored = JSON.parse(await readFile(path.join(appDataSubdirs(dir).db, "canvas-feed.json"), "utf8"));
  assert.equal(stored.url, FEED_URL);

  await forgetFeed(dir);
  assert.deepEqual(await getFeedStatus(dir), { connected: false, host: null });
});

test("listing and importing: upcoming events only, imported once, changes flagged but never applied", async () => {
  const dir = await makeTempDir("athena-canvas-feed-");
  const bio = await createSubject(dir, { name: "Biology" });
  await rejectsFeedError(listFeedEvents(dir, { today: "2026-10-22", fetchImpl: fakeFetch(ics([])) }), /Connect/);

  const events = [
    { uid: "past", dtstart: "20261001", summary: "Old quiz [Biology 101]" },
    { uid: "lab", dtstart: "20261030", summary: "Lab report [Biology 101]" },
    { uid: "exam", dtstart: "20261105", summary: "Midterm [Biology 101]" },
  ];
  await saveFeedUrl(dir, FEED_URL, { fetchImpl: fakeFetch(ics(events)) });

  const listed = await listFeedEvents(dir, { today: "2026-10-22", fetchImpl: fakeFetch(ics(events)) });
  assert.deepEqual(
    listed.map((e) => [e.uid, e.imported, e.suggestedSubjectId]),
    [
      ["lab", null, bio.id],
      ["exam", null, bio.id],
    ],
  );

  await rejectsFeedError(importFeedEvents(dir, { subjectId: bio.id, uids: [] }, { fetchImpl: fakeFetch(ics(events)) }), /Tick/);
  await rejectsFeedError(importFeedEvents(dir, { subjectId: "nope", uids: ["lab"] }, { fetchImpl: fakeFetch(ics(events)) }), /subject/);

  const result = await importFeedEvents(dir, { subjectId: bio.id, uids: ["lab", "exam", "not-in-feed"] }, { fetchImpl: fakeFetch(ics(events)) });
  assert.equal(result.added.length, 2);
  assert.equal(result.skipped, 1);
  const deadlines = await listDeadlines(dir, bio.id);
  assert.deepEqual(
    deadlines.map((d) => [d.title, d.date, d.source, d.externalId, d.studying]),
    [
      ["Lab report", "2026-10-30", "canvas", "lab", true],
      ["Midterm", "2026-11-05", "canvas", "exam", true],
    ],
  );

  // Importing again adds nothing.
  const again = await importFeedEvents(dir, { subjectId: bio.id, uids: ["lab"] }, { fetchImpl: fakeFetch(ics(events)) });
  assert.deepEqual([again.added.length, again.skipped], [0, 1]);

  // Canvas moves the midterm; the user renamed the lab themselves.
  const lab = deadlines.find((d) => d.externalId === "lab");
  await updateDeadline(dir, bio.id, lab.id, { title: "Lab report (photosynthesis)" });
  const moved = events.map((e) => (e.uid === "exam" ? { ...e, dtstart: "20261112" } : e));
  const relisted = await listFeedEvents(dir, { today: "2026-10-22", fetchImpl: fakeFetch(ics(moved)) });
  const exam = relisted.find((e) => e.uid === "exam");
  assert.equal(exam.changed, true);
  assert.equal(exam.imported.date, "2026-11-05");
  assert.equal(exam.date, "2026-11-12");
  assert.equal(relisted.find((e) => e.uid === "lab").changed, true);
  // Nothing was rewritten behind the user's back.
  assert.equal((await listDeadlines(dir, bio.id)).find((d) => d.externalId === "exam").date, "2026-11-05");
});
