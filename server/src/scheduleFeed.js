// The suggested schedule as a calendar feed (SPEC-v2.md section 2, the
// item deferred past v0.8.0): GET /api/schedule/feed.ics, which a calendar
// app on this computer (Apple Calendar, Thunderbird, Outlook desktop) can
// subscribe to. It's the same plan the Calendar shows, from getSchedule,
// so it follows every move, delete and done the user makes; nothing new is
// stored and no model is called.
//
// One all-day event per day that has topics, not one per topic: a day's
// list of five-minute topics would bury the rest of the user's calendar.
// Each day's UID is fixed ("<date>@athena-studying"), so a refresh updates
// that day's event in place instead of adding a copy, and a day that no
// longer has anything planned simply drops out of the feed.
//
// It only works for apps on the same computer: the server listens on
// 127.0.0.1, so an online calendar (Google, or an iCloud-stored
// subscription) can't fetch it, and the topic names never leave the
// machine. That's the same reach as the rest of the API, so the feed
// needs no secret of its own.

const PRODID = "-//Athena-Studying//Study plan//EN";
const MAX_LINE_OCTETS = 75;

/** RFC 5545 TEXT escaping. Control characters are dropped, so a topic name
 * can never start a new property line of its own. */
export function escapeText(value) {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
    .replace(/[\\;,]/g, (c) => `\\${c}`)
    .replace(/\n/g, "\\n");
}

/** Folds a content line at 75 octets (RFC 5545 3.1), never inside a UTF-8
 * character. Continuation lines start with one space. */
export function foldLine(line) {
  const parts = [];
  let current = "";
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    // Continuation lines spend one octet on their leading space.
    const limit = parts.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const basicDate = (date) => date.replaceAll("-", "");

function nextDay(date) {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

function utcStamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function dayEvent(day, minutesPerBlock, stamp) {
  const blocks = day.blocks.filter((b) => b.status === "planned" || b.status === "done");
  if (blocks.length === 0) return null;
  const planned = blocks.filter((b) => b.status === "planned");
  const summary =
    planned.length === 0
      ? `Studied ${blocks.length} topic${blocks.length === 1 ? "" : "s"} (Athena)`
      : `Study ${planned.length} topic${planned.length === 1 ? "" : "s"}, about ${planned.length * minutesPerBlock} min (Athena)`;
  const description = blocks
    .map((b) => `${b.status === "done" ? "Done: " : ""}${b.subjectName}: ${b.topicName}`)
    .join("\n");
  return [
    "BEGIN:VEVENT",
    `UID:${day.date}@athena-studying`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${basicDate(day.date)}`,
    `DTEND;VALUE=DATE:${basicDate(nextDay(day.date))}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ];
}

/** The schedule (getSchedule's shape) as an iCalendar file. Pure. */
export function scheduleToIcs(schedule, now = new Date()) {
  const stamp = utcStamp(now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Athena study plan",
    // Hints for how often to re-fetch; apps that ignore them use their own.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const day of schedule.days) {
    const event = dayEvent(day, schedule.minutesPerBlock, stamp);
    if (event) lines.push(...event);
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
