import { afterEach, expect, test } from "vitest";
import { addDays, dayHeading, daysBetween, formatDay, localToday, parseLocalDate, relativeDay, weekStart } from "./calendarDates";

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

test("localToday is the local calendar day, also late in the evening west of UTC", () => {
  process.env.TZ = "America/Los_Angeles";
  // 23:30 local on Oct 31 is already Nov 1 in UTC.
  expect(localToday(new Date(2026, 9, 31, 23, 30))).toBe("2026-10-31");
  process.env.TZ = "Pacific/Auckland";
  expect(localToday(new Date(2026, 10, 1, 0, 15))).toBe("2026-11-01");
});

test("a YYYY-MM-DD date shows as that same day in every zone, never the day before", () => {
  for (const tz of ["America/Los_Angeles", "Pacific/Auckland", "Europe/Prague"]) {
    process.env.TZ = tz;
    expect(parseLocalDate("2026-11-01")?.getDate()).toBe(1);
    expect(formatDay("2026-11-01")).toMatch(/1/);
    expect(formatDay("2026-11-01")).toMatch(/Sun/);
  }
  expect(parseLocalDate("2026-02-30")).toBeNull();
  expect(parseLocalDate("nope")).toBeNull();
  expect(formatDay("nope")).toBe("nope");
});

test("day differences are whole days across DST changes", () => {
  process.env.TZ = "America/New_York";
  expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
  expect(daysBetween("2027-03-13", "2027-03-15")).toBe(2);
  expect(relativeDay("2026-11-02", "2026-10-31")).toBe("in 2 days");
});

test("relative labels and day headings", () => {
  expect(relativeDay("2026-10-20", "2026-10-20")).toBe("today");
  expect(relativeDay("2026-10-21", "2026-10-20")).toBe("tomorrow");
  expect(relativeDay("2026-10-19", "2026-10-20")).toBe("yesterday");
  expect(relativeDay("2026-10-17", "2026-10-20")).toBe("3 days ago");
  expect(dayHeading("2026-10-20", "2026-10-20")).toMatch(/^Today · /);
  expect(dayHeading("2026-10-21", "2026-10-20")).toMatch(/^Tomorrow · /);
  expect(dayHeading("2026-10-23", "2026-10-20")).not.toMatch(/Today|Tomorrow/);
});

test("addDays crosses month and year ends, and DST changes, without slipping a day", () => {
  expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  expect(addDays("2026-03-07", 2)).toBe("2026-03-09"); // US DST starts 2026-03-08
  expect(addDays("2026-10-20", 0)).toBe("2026-10-20");
});

test("weekStart is the Monday on or before the date", () => {
  expect(weekStart("2026-10-19")).toBe("2026-10-19"); // Monday
  expect(weekStart("2026-10-25")).toBe("2026-10-19"); // Sunday
  expect(weekStart("2026-11-01")).toBe("2026-10-26"); // Sunday, across a month end
});
