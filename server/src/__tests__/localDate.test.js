// Day-level date handling for deadlines and the schedule. Each test file
// runs in its own process, so setting TZ here only affects this file;
// Node re-reads TZ when it changes, on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, daysBetween, isValidDateString, localDateOf, weekdayOf } from "../localDate.js";

function inZone(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

test("localDateOf uses the local calendar day, not the UTC one", () => {
  // 03:30 UTC on Nov 1 is still Oct 31 in New York and already Nov 1 in Auckland.
  const instant = Date.parse("2026-11-01T03:30:00Z");
  assert.equal(inZone("America/New_York", () => localDateOf(instant)), "2026-10-31");
  assert.equal(inZone("Pacific/Auckland", () => localDateOf(instant)), "2026-11-01");
  assert.equal(inZone("UTC", () => localDateOf(new Date(instant))), "2026-11-01");
  assert.equal(inZone("UTC", () => localDateOf("2026-11-01T03:30:00Z")), "2026-11-01");
});

test("just before and after local midnight on a DST-change day land on the right days", () => {
  inZone("America/New_York", () => {
    // US clocks fall back at 02:00 on 2026-11-01.
    assert.equal(localDateOf(new Date(2026, 10, 1, 0, 30)), "2026-11-01");
    assert.equal(localDateOf(new Date(2026, 9, 31, 23, 59)), "2026-10-31");
    assert.equal(localDateOf(new Date(2026, 10, 1, 23, 59)), "2026-11-01");
  });
  inZone("Europe/Prague", () => {
    // EU clocks fall back on 2026-10-25 and spring forward on 2027-03-28.
    assert.equal(localDateOf(new Date(2026, 9, 25, 23, 30)), "2026-10-25");
    assert.equal(localDateOf(new Date(2027, 2, 28, 0, 30)), "2027-03-28");
  });
});

test("day arithmetic is exact across DST changes in any zone", () => {
  for (const tz of ["America/New_York", "Europe/Prague", "Australia/Sydney", "UTC"]) {
    inZone(tz, () => {
      assert.equal(addDays("2026-10-31", 1), "2026-11-01");
      assert.equal(addDays("2026-11-01", 1), "2026-11-02");
      assert.equal(addDays("2026-10-24", 2), "2026-10-26");
      assert.equal(addDays("2027-03-27", 2), "2027-03-29");
      assert.equal(addDays("2026-12-31", 1), "2027-01-01");
      assert.equal(addDays("2028-02-28", 1), "2028-02-29");
      assert.equal(addDays("2026-11-02", -2), "2026-10-31");
      assert.equal(daysBetween("2026-10-20", "2026-11-03"), 14);
      assert.equal(daysBetween("2027-03-20", "2027-04-03"), 14);
      // Fourteen consecutive days never skip or repeat a date.
      const days = [];
      for (let d = "2026-10-25"; days.length < 14; d = addDays(d, 1)) days.push(d);
      assert.equal(new Set(days).size, 14);
      assert.equal(days.at(-1), "2026-11-07");
    });
  }
});

test("weekdayOf: 0 is Sunday, independent of the local zone", () => {
  for (const tz of ["Pacific/Auckland", "America/Los_Angeles"]) {
    inZone(tz, () => {
      assert.equal(weekdayOf("2026-10-20"), 2);
      assert.equal(weekdayOf("2026-10-25"), 0);
      assert.equal(weekdayOf("2026-10-31"), 6);
    });
  }
});

test("isValidDateString accepts real dates only", () => {
  assert.equal(isValidDateString("2026-10-20"), true);
  assert.equal(isValidDateString("2028-02-29"), true);
  for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-1-1", "20261020", "", null, 20261020, "2026-10-20T00:00"]) {
    assert.equal(isValidDateString(bad), false, String(bad));
  }
});
