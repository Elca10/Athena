// Day-level date helpers for deadlines and the Calendar. Dates travel as
// local "YYYY-MM-DD" strings (server/src/localDate.js has the why); these
// never turn one into a UTC midnight, which would show the day before for
// anyone west of Greenwich. Kept out of api.ts: panel tests mock that
// whole module, and these must run for real.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Monday-first, the way most students' weeks run. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Local noon on that day: far from midnight, so DST can't shift the day. */
export function parseLocalDate(date: string): Date | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return d.getDate() === Number(m[3]) ? d : null;
}

export function daysBetween(from: string, to: string): number {
  const utc = (s: string) => {
    const m = DATE_RE.exec(s);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** "Tue, Oct 20" */
export function formatDay(date: string): string {
  const d = parseLocalDate(date);
  return d ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : date;
}

/** "today", "tomorrow", "in 5 days", "yesterday", "3 days ago". */
export function relativeDay(date: string, today: string): string {
  const n = daysBetween(today, date);
  if (Number.isNaN(n)) return "";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** A Calendar day heading: "Today · Tue, Oct 20", "Tomorrow · ...", or just the day. */
export function dayHeading(date: string, today: string): string {
  const n = daysBetween(today, date);
  if (n === 0) return `Today · ${formatDay(date)}`;
  if (n === 1) return `Tomorrow · ${formatDay(date)}`;
  return formatDay(date);
}
