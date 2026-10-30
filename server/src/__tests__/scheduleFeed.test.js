// The Calendar's plan as an iCalendar feed (scheduleFeed.js): one all-day
// event per day with topics, stable per-day UIDs, and text that can't
// break out of its property line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleToIcs, escapeText, foldLine } from "../scheduleFeed.js";

const block = (topicName, status = "planned", subjectName = "Biology") => ({ topicName, subjectName, status });
const schedule = (days) => ({ minutesPerBlock: 5, days });
const NOW = new Date("2026-10-30T09:15:00.000Z");

/** Unfolded content lines. */
const linesOf = (ics) => ics.replace(/\r\n /g, "").split("\r\n");
const events = (ics) => ics.split("BEGIN:VEVENT").slice(1).map((e) => linesOf(e));
const prop = (lines, name) => lines.find((l) => l.startsWith(name))?.slice(name.length);

test("a calendar with one all-day event per day that has topics", () => {
  const ics = scheduleToIcs(
    schedule([
      { date: "2026-10-30", blocks: [block("Cells"), block("Mitosis")] },
      { date: "2026-10-31", blocks: [] },
      { date: "2026-11-01", blocks: [block("Osmosis", "planned", "Chemistry")] },
    ]),
    NOW,
  );
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every line ends in CRLF");
  const [first, second, ...rest] = events(ics);
  assert.equal(rest.length, 0, "an empty day has no event");
  assert.equal(prop(first, "UID:"), "2026-10-30@athena-studying");
  assert.equal(prop(first, "DTSTART;VALUE=DATE:"), "20261030");
  assert.equal(prop(first, "DTEND;VALUE=DATE:"), "20261031");
  assert.equal(prop(first, "DTSTAMP:"), "20261030T091500Z");
  assert.equal(prop(first, "SUMMARY:"), "Study 2 topics\\, about 10 min (Athena)");
  assert.equal(prop(first, "DESCRIPTION:"), "Biology: Cells\\nBiology: Mitosis");
  assert.equal(prop(second, "UID:"), "2026-11-01@athena-studying");
  assert.equal(prop(second, "SUMMARY:"), "Study 1 topic\\, about 5 min (Athena)");
});

test("the month boundary and year end get the right end date", () => {
  const ics = scheduleToIcs(schedule([{ date: "2026-12-31", blocks: [block("A")] }]), NOW);
  assert.equal(prop(events(ics)[0], "DTEND;VALUE=DATE:"), "20270101");
});

test("done topics are listed as done; deleted ones are left out", () => {
  const ics = scheduleToIcs(
    schedule([
      { date: "2026-10-30", blocks: [block("Cells"), block("Mitosis", "done"), block("Gone", "deleted")] },
      { date: "2026-10-31", blocks: [block("Osmosis", "done")] },
      { date: "2026-11-01", blocks: [block("Gone", "deleted")] },
    ]),
    NOW,
  );
  const [today, tomorrow, ...rest] = events(ics);
  assert.equal(rest.length, 0, "a day with only deleted topics has no event");
  assert.equal(prop(today, "SUMMARY:"), "Study 1 topic\\, about 5 min (Athena)");
  assert.equal(prop(today, "DESCRIPTION:"), "Biology: Cells\\nDone: Biology: Mitosis");
  assert.ok(!ics.includes("Gone"));
  assert.equal(prop(tomorrow, "SUMMARY:"), "Studied 1 topic (Athena)");
});

test("a topic name can't inject its own calendar lines", () => {
  const ics = scheduleToIcs(
    schedule([{ date: "2026-10-30", blocks: [block("Evil\r\nEND:VEVENT\r\nBEGIN:VEVENT\rUID:x;y,z\\")] }]),
    NOW,
  );
  // Whole lines only: the escaped text itself still contains "BEGIN:VEVENT".
  assert.equal(linesOf(ics).filter((l) => l === "BEGIN:VEVENT").length, 1);
  assert.equal(linesOf(ics).filter((l) => l === "END:VEVENT").length, 1);
  assert.equal(prop(linesOf(ics), "DESCRIPTION:"), "Biology: Evil\\nEND:VEVENT\\nBEGIN:VEVENT\\nUID:x\\;y\\,z\\\\");
});

test("escapeText drops control characters other than newlines", () => {
  assert.equal(escapeText("a\tb\x00c\x7fd"), "abcd");
  assert.equal(escapeText("one\ntwo"), "one\\ntwo");
});

test("long lines fold at 75 octets without splitting a character", () => {
  const line = "DESCRIPTION:" + "é".repeat(100) + "x".repeat(40);
  const folded = foldLine(line);
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1);
  for (const [i, part] of parts.entries()) {
    assert.ok(Buffer.byteLength(part) <= 75, `line ${i} is ${Buffer.byteLength(part)} octets`);
    if (i > 0) assert.ok(part.startsWith(" "));
    assert.ok(!part.includes("�"));
  }
  assert.equal(folded.replace(/\r\n /g, ""), line);
  assert.equal(foldLine("short"), "short");
});
