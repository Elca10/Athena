// The DST-change case for the suggested schedule (schedule.js), split out
// of schedule.test.js on purpose (see that file's comment where this test
// used to live): this is the one place in the schedule suite that mutates
// process.env.TZ mid-process, to pin down a real local day ("2026-11-01",
// when US clocks fall back) rather than whatever zone the test machine
// happens to be in. Restoring TZ afterwards isn't reliable on every OS
// (Windows in particular can leave a mid-process TZ override in effect
// after it's reset), so this is kept as the ONLY test in its own file —
// node's test runner (`node --test`) isolates test files into separate
// processes, so even if the restore silently doesn't take effect, there's
// no later test in this process for a leaked zone to poison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSchedule } from "../schedule.js";

const subjects = [{ id: "s1", name: "Biology" }];
const blocks = (s) => s.days.flatMap((d) => d.blocks);
const daysOf = (s, topicId) => blocks(s).filter((b) => b.topicId === topicId).map((b) => b.date);

test("over a DST change the schedule has 14 consecutive days and topics land on their local day", () => {
  const before = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const due = new Date(2026, 10, 1, 0, 30).getTime(); // 00:30 local on the day clocks fall back
    const s = computeSchedule({ today: "2026-10-28", subjects, topics: [{ id: "a", subjectId: "s1", name: "A", fsrs: { due } }] });
    const dates = s.days.map((d) => d.date);
    assert.equal(new Set(dates).size, 14);
    assert.equal(dates.at(-1), "2026-11-10");
    assert.deepEqual(daysOf(s, "a"), ["2026-11-01"]);
    assert.equal(s.days.find((d) => d.date === "2026-11-01").weekday, 0);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});
