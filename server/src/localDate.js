// Calendar dates for deadlines and the study schedule, stored as plain
// "YYYY-MM-DD" strings in the user's own local time zone (Athena runs on
// the user's machine, so the server's local zone is the user's).
//
// Why strings and not timestamps: a deadline is a day, not an instant. An
// exam "on Oct 30" stored as midnight UTC shows up as Oct 29 for anyone
// west of Greenwich, and a DST change can make "one day later" 23 or 25
// hours away. So every day-level calculation here works on the date
// string itself, with day arithmetic done through UTC (where every day is
// exactly 24 hours), and only `localDateOf` ever looks at a real clock.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, "0");
}

/** The local calendar date of an instant (a Date, epoch ms or ISO string). */
export function localDateOf(instant = new Date()) {
  const d = instant instanceof Date ? instant : new Date(instant);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isValidDateString(value) {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(y, mo - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === mo - 1 && utc.getUTCDate() === d;
}

function toUtcMs(dateString) {
  const m = DATE_RE.exec(dateString);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${dateString}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtcMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(dateString, days) {
  return fromUtcMs(toUtcMs(dateString) + days * DAY_MS);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a, b) {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday, the same numbering as Date#getDay. */
export function weekdayOf(dateString) {
  return new Date(toUtcMs(dateString)).getUTCDay();
}
