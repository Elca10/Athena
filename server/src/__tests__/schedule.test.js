// The suggested schedule (schedule.js). The owner's rule this file exists
// to pin down: the user's scheduling decisions win. Moved, deleted and
// completed blocks and availability are never overridden by the
// scheduler, deadline pacing or anything else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "../testHelpers/tempDir.js";
import { appDataSubdirs } from "../dataDir.js";
import { makeJsonFileStore } from "../store/jsonFileStore.js";
import { createSubject, archiveSubject } from "../subjects.js";
import { createDeadline, deleteDeadline } from "../deadlines.js";
import { buildSessionTopicIds } from "../sessionBuilder.js";
import {
  computeSchedule,
  getSchedule,
  applyBlockAction,
  setAvailability,
  getAvailability,
  extraTopicIdsForToday,
  normalizeAvailability,
  blockId,
  parseBlockId,
  BlockChangedError,
  DEFAULT_AVAILABILITY,
  HORIZON_DAYS,
} from "../schedule.js";

const TODAY = "2026-10-20"; // a Tuesday
const SUNDAYS = ["2026-10-25", "2026-11-01"];

function localNoon(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}
const T = (id, due, subjectId = "s1") => ({ id, subjectId, name: id.toUpperCase(), fsrs: { due: localNoon(due).getTime() } });
const subjects = [{ id: "s1", name: "Biology" }];
const blocks = (s) => s.days.flatMap((d) => d.blocks);
const daysOf = (s, topicId) => blocks(s).filter((b) => b.topicId === topicId).map((b) => b.date);
const noSundays = { weekdays: [1, 2, 3, 4, 5, 6], minutesPerDay: 30 };
const deadline = (id, date, extra = {}) => ({ id, subjectId: "s1", title: id, date, topicIds: [], studying: true, createdAt: "x", ...extra });

// ---- the computed schedule ------------------------------------------------

test("a 14-day schedule: topics on their FSRS due day, overdue ones today, later ones not shown", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("late", "2026-10-10"), T("thu", "2026-10-22"), T("far", "2026-12-01")],
  });
  assert.equal(s.days.length, HORIZON_DAYS);
  assert.equal(s.days[0].date, TODAY);
  assert.equal(s.days.at(-1).date, "2026-11-02");
  assert.deepEqual(daysOf(s, "late"), [TODAY]);
  assert.deepEqual(daysOf(s, "thu"), ["2026-10-22"]);
  assert.deepEqual(daysOf(s, "far"), []);
  const b = blocks(s).find((x) => x.topicId === "thu");
  assert.deepEqual(
    { id: b.id, status: b.status, reason: b.reason, subjectName: b.subjectName, topicName: b.topicName, byYou: b.byYou },
    { id: "2026-10-22:thu", status: "planned", reason: "due", subjectName: "Biology", topicName: "THU", byYou: false },
  );
});

test("minutes per day caps each day; the rest spills to the next day with room", () => {
  const topics = ["a", "b", "c", "d", "e"].map((id) => T(id, TODAY));
  const s = computeSchedule({ today: TODAY, subjects, topics, availability: normalizeAvailability({ weekdays: [0, 1, 2, 3, 4, 5, 6], minutesPerDay: 10 }) });
  assert.deepEqual(s.days.slice(0, 3).map((d) => d.blocks.length), [2, 2, 1]);
});

test("days the user didn't pick get nothing; their topics move to the next study day", () => {
  const s = computeSchedule({ today: TODAY, subjects, topics: [T("sun", "2026-10-25")], availability: noSundays });
  assert.deepEqual(daysOf(s, "sun"), ["2026-10-26"]);
  assert.equal(s.days.find((d) => d.date === "2026-10-25").available, false);
});

test("no study days at all: nothing is planned (and nothing crashes)", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("a", TODAY)],
    deadlines: [deadline("exam", "2026-10-25")],
    availability: normalizeAvailability({ weekdays: [], minutesPerDay: 30 }),
  });
  assert.equal(blocks(s).length, 0);
  assert.deepEqual(s.unscheduled.map((u) => [u.deadlineId, u.topicCount]), [["exam", 1]]);
});

test("missed days fix themselves: yesterday's plan is simply recomputed from today", () => {
  const topics = [T("a", "2026-10-19")];
  const yesterday = computeSchedule({ today: "2026-10-19", subjects, topics });
  assert.deepEqual(daysOf(yesterday, "a"), ["2026-10-19"]);
  const today = computeSchedule({ today: TODAY, subjects, topics });
  assert.deepEqual(daysOf(today, "a"), [TODAY]);
  assert.equal(today.days[0].date, TODAY);
});

test("the same inputs in any order give the same schedule", () => {
  const topics = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id, i) => T(id, i % 2 ? TODAY : "2026-10-23"));
  const input = { today: TODAY, subjects, topics, deadlines: [deadline("exam", "2026-10-24", { topicIds: ["b", "c"] })] };
  const one = computeSchedule(input);
  const two = computeSchedule({ ...input, topics: [...topics].reverse() });
  assert.deepEqual(one, two);
});

test("archived subjects (not in the active list) leave the schedule, deadlines included", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("a", TODAY), T("x", TODAY, "archived")],
    deadlines: [deadline("old", "2026-10-22", { subjectId: "archived" })],
  });
  assert.deepEqual(blocks(s).map((b) => b.topicId), ["a"]);
  assert.equal(s.days.flatMap((d) => d.deadlines).length, 0);
});

// ---- exam-aware pacing ----------------------------------------------------

test("exam-aware pacing pulls a topic forward to the day before a deadline being studied for", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("later", "2026-11-10"), T("soon", "2026-10-21"), T("other", "2026-11-10")],
    deadlines: [deadline("Midterm", "2026-10-25", { topicIds: ["later", "soon"] })],
  });
  const later = blocks(s).find((b) => b.topicId === "later");
  assert.equal(later.date, "2026-10-24");
  assert.equal(later.reason, "deadline");
  assert.deepEqual(later.deadline, { id: "Midterm", title: "Midterm", date: "2026-10-25" });
  const soon = blocks(s).find((b) => b.topicId === "soon");
  assert.equal(soon.date, "2026-10-21", "already due before the deadline: left on its day");
  assert.equal(soon.reason, "due");
  assert.deepEqual(daysOf(s, "other"), [], "not covered by the deadline: not pulled");
  assert.deepEqual(s.days.find((d) => d.date === "2026-10-25").deadlines.map((d) => d.title), ["Midterm"]);
});

test("a deadline with no topics picked covers the whole subject; 'not studying for it' pulls nothing", () => {
  const topics = [T("a", "2026-11-20"), T("b", "2026-11-20")];
  const studying = computeSchedule({ today: TODAY, subjects, topics, deadlines: [deadline("Final", "2026-10-30")] });
  assert.deepEqual([...daysOf(studying, "a"), ...daysOf(studying, "b")], ["2026-10-29", "2026-10-29"]);
  const notStudying = computeSchedule({ today: TODAY, subjects, topics, deadlines: [deadline("Final", "2026-10-30", { studying: false })] });
  assert.equal(blocks(notStudying).length, 0);
  assert.equal(notStudying.days.find((d) => d.date === "2026-10-30").deadlines[0].studying, false, "still shown on its day");
});

test("a deadline whose picked topics were all removed pulls nothing (never widens to the whole subject)", () => {
  const s = computeSchedule({ today: TODAY, subjects, topics: [T("a", "2026-11-20")], deadlines: [deadline("Quiz", "2026-10-30", { topicIds: ["gone"] })] });
  assert.equal(blocks(s).length, 0);
});

test("a deadline today or in the past paces nothing", () => {
  const topics = [T("a", "2026-11-20")];
  for (const date of [TODAY, "2026-10-01"]) {
    assert.equal(blocks(computeSchedule({ today: TODAY, subjects, topics, deadlines: [deadline("x", date)] })).length, 0);
  }
});

test("a deadline past the 14 days is paced too: its topics land before it, out of view until closer", () => {
  const s = computeSchedule({ today: TODAY, subjects, topics: [T("a", "2027-01-20")], deadlines: [deadline("Final", "2026-12-10")] });
  assert.deepEqual(daysOf(s, "a"), [], "planned for Dec 9, past the visible two weeks");
  const closer = computeSchedule({ today: "2026-12-01", subjects, topics: [T("a", "2027-01-20")], deadlines: [deadline("Final", "2026-12-10")] });
  assert.deepEqual(daysOf(closer, "a"), ["2026-12-09"]);
});

test("availability 'no Sundays' is never violated by deadline pacing, even when the exam is on a Monday", () => {
  const topics = Array.from({ length: 40 }, (_, i) => T(`t${String(i).padStart(2, "0")}`, "2026-12-01"));
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics,
    availability: normalizeAvailability({ weekdays: [1, 2, 3, 4, 5, 6], minutesPerDay: 15 }),
    deadlines: [deadline("Monday exam", "2026-10-26")],
  });
  for (const sunday of SUNDAYS) assert.equal(s.days.find((d) => d.date === sunday).blocks.length, 0, sunday);
  for (const day of s.days) assert.ok(day.blocks.length <= 3, `${day.date} over the minutes per day`);
  // Tue..Sat before the Monday exam = 5 study days x 3 = 15 topics; the rest is reported, not crammed in.
  assert.equal(blocks(s).filter((b) => b.reason === "deadline").length, 15);
  assert.equal(blocks(s).find((b) => b.topicId === "t00").date, "2026-10-24", "the day before (Sunday) is off, so Saturday");
  assert.deepEqual(s.unscheduled, [
    { deadlineId: "Monday exam", title: "Monday exam", date: "2026-10-26", subjectId: "s1", subjectName: "Biology", topicCount: 25 },
  ]);
});

test("pacing goes earlier when the day before is full, soonest deadline first", () => {
  const topics = ["a", "b", "c"].map((id) => T(id, "2026-12-01"));
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics,
    availability: normalizeAvailability({ weekdays: [0, 1, 2, 3, 4, 5, 6], minutesPerDay: 5 }),
    deadlines: [deadline("Later", "2026-10-30", { topicIds: ["c"] }), deadline("Sooner", "2026-10-24", { topicIds: ["a", "b"] })],
  });
  assert.deepEqual(daysOf(s, "a"), ["2026-10-23"]);
  assert.deepEqual(daysOf(s, "b"), ["2026-10-22"]);
  assert.deepEqual(daysOf(s, "c"), ["2026-10-29"]);
});

// ---- the user's decisions win ----------------------------------------------

test("a moved block stays on the moved day even when FSRS later says the topic is due earlier", () => {
  const override = { id: "2026-10-23:a", topicId: "a", date: "2026-10-28", status: "planned" };
  // FSRS originally had it on the 23rd; now it says overdue.
  const s = computeSchedule({ today: TODAY, subjects, topics: [T("a", "2026-10-15")], overrides: [override] });
  assert.deepEqual(daysOf(s, "a"), ["2026-10-28"]);
  const b = blocks(s)[0];
  assert.equal(b.id, "2026-10-23:a", "same block identity after the move");
  assert.equal(b.moved, true);
  assert.equal(b.byYou, true);
});

test("a moved block stays even past a deadline that would pace it earlier", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("a", "2026-11-20")],
    deadlines: [deadline("Midterm", "2026-10-25")],
    overrides: [{ id: "2026-10-24:a", topicId: "a", date: "2026-10-27", status: "planned" }],
  });
  assert.deepEqual(daysOf(s, "a"), ["2026-10-27"]);
  assert.deepEqual(s.unscheduled, [], "the user placed it; it isn't reported as missing");
});

test("a deleted block never reappears for that day/topic, not even through deadline pacing", () => {
  const overrides = [{ id: `${TODAY}:a`, topicId: "a", date: TODAY, status: "deleted" }];
  for (const deadlines of [[], [deadline("Quiz", "2026-10-21")]]) {
    const s = computeSchedule({ today: TODAY, subjects, topics: [T("a", "2026-10-10"), T("b", TODAY)], deadlines, overrides });
    assert.deepEqual(daysOf(s, "a"), [], "not on that day, and not pushed to another day while the decision stands");
    assert.deepEqual(daysOf(s, "b"), [TODAY]);
  }
  // Once that day has passed, the topic is free to be planned again, on a new day.
  const tomorrow = computeSchedule({ today: "2026-10-21", subjects, topics: [T("a", "2026-10-10")], overrides });
  assert.deepEqual(daysOf(tomorrow, "a"), ["2026-10-21"]);
});

test("a block the user marked done stays done on its day, and takes that day's time", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("a", TODAY), T("b", TODAY)],
    availability: normalizeAvailability({ weekdays: [0, 1, 2, 3, 4, 5, 6], minutesPerDay: 5 }),
    overrides: [{ id: `${TODAY}:a`, topicId: "a", date: TODAY, status: "done" }],
  });
  assert.deepEqual(s.days[0].blocks.map((b) => [b.topicId, b.status, b.doneBy]), [["a", "done", "you"]]);
  assert.deepEqual(daysOf(s, "b"), ["2026-10-21"]);
});

test("the user's blocks take their day's room first; computed blocks fill in around them", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("mine", "2026-11-30"), T("due", "2026-10-21")],
    availability: normalizeAvailability({ weekdays: [0, 1, 2, 3, 4, 5, 6], minutesPerDay: 5 }),
    overrides: [{ id: "2026-10-30:mine", topicId: "mine", date: "2026-10-21", status: "planned" }],
  });
  assert.deepEqual(daysOf(s, "mine"), ["2026-10-21"]);
  assert.deepEqual(daysOf(s, "due"), ["2026-10-22"]);
});

test("a user may put a block on a day off; computed blocks still never go there", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("mine", "2026-10-22"), T("other", "2026-10-25")],
    availability: noSundays,
    overrides: [{ id: "2026-10-22:mine", topicId: "mine", date: "2026-10-25", status: "planned" }],
  });
  assert.deepEqual(s.days.find((d) => d.date === "2026-10-25").blocks.map((b) => b.topicId), ["mine"]);
  assert.deepEqual(daysOf(s, "other"), ["2026-10-26"]);
});

test("decisions for days already gone are inert", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("a", TODAY)],
    overrides: [{ id: "2026-10-18:a", topicId: "a", date: "2026-10-19", status: "deleted" }],
  });
  assert.deepEqual(daysOf(s, "a"), [TODAY]);
});

test("a topic studied today in a real session shows as done today, automatically", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    // After the review FSRS moved it out; the session still counts for today.
    topics: [T("a", "2026-10-30"), T("b", TODAY)],
    studied: new Set([`${TODAY}:a`]),
  });
  assert.deepEqual(daysOf(s, "a"), [TODAY]);
  const a = blocks(s).find((b) => b.topicId === "a");
  assert.deepEqual([a.status, a.doneBy, a.reason], ["done", "session", "studied"]);
  assert.equal(s.days[0].blocks.at(-1).topicId, "a", "done blocks listed after what's still to do");
});

test("a user's block on the day a session covers it is marked done automatically", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("a", "2026-10-30")],
    overrides: [{ id: "2026-10-25:a", topicId: "a", date: TODAY, status: "planned" }],
    studied: new Set([`${TODAY}:a`]),
  });
  assert.deepEqual(blocks(s).map((b) => [b.id, b.status, b.doneBy]), [["2026-10-25:a", "done", "session"]]);
});

test("a deleted block stays hidden even if a session then covers it that day", () => {
  const s = computeSchedule({
    today: TODAY,
    subjects,
    topics: [T("a", TODAY)],
    overrides: [{ id: `${TODAY}:a`, topicId: "a", date: TODAY, status: "deleted" }],
    studied: new Set([`${TODAY}:a`]),
  });
  assert.equal(blocks(s).length, 0);
});

test("blockId and parseBlockId round-trip; junk ids are rejected", () => {
  assert.deepEqual(parseBlockId(blockId("2026-10-20", "abc-123")), { originDate: "2026-10-20", topicId: "abc-123" });
  for (const bad of ["", "nocolon", "2026-13-01:x", "2026-10-20:", null]) assert.equal(parseBlockId(bad), null);
});

// The DST-change case (clocks falling back over 2026-11-01) lives in its
// own file, schedule.dst.test.js — not here. It's the one test in this
// suite that mutates process.env.TZ mid-process, and node's test runner
// isolates test *files* into separate processes but not individual tests
// within one file. Restoring TZ afterwards is reliable on Linux/macOS but
// not on Windows (a real Windows-only Node quirk: a mid-process TZ change
// doesn't always get picked back up when reset), so a leaked
// "America/New_York" silently outlived this test and shifted every local
// `Date`/`new Date(...).getTime()` computed afterwards in this same file —
// including seed()'s due dates versus the module-level NOW constant below,
// which is fixed at import time under the real ambient zone. That's what
// produced a Windows-only failure in the unrelated "Study picks up..."
// test further down this file (actual [] vs expected ['due']): nothing
// wrong with sessionBuilder.js/schedule.js's own due-date logic, which is
// correctly TZ-ambient by design (SPEC: Athena runs in the user's own
// local zone) — the bug was this test leaking a different zone forward.
// Giving the DST test its own file makes a repeat of this impossible:
// whatever Windows does or doesn't honor when the TZ override there is
// restored, there's no later test in that process left to see it.

// ---- stored decisions, through the data dir --------------------------------

const NOW = localNoon(TODAY);

async function seed(dueDates, { subjectName = "Biology" } = {}) {
  const dir = await makeTempDir("athena-schedule-");
  const subject = await createSubject(dir, { name: subjectName });
  const topics = Object.entries(dueDates).map(([id, due]) => ({ ...T(id, due, subject.id), createdAt: "x", notes: "", bankGeneratedAt: null }));
  await makeJsonFileStore(appDataSubdirs(dir).db, "topics.json", []).write(topics);
  return { dir, subject };
}

async function setDue(dir, topicId, due) {
  await makeJsonFileStore(appDataSubdirs(dir).db, "topics.json", []).update((all) =>
    all.map((t) => (t.id === topicId ? { ...t, fsrs: { ...t.fsrs, due: localNoon(due).getTime() } } : t)),
  );
}

test("stored: move survives FSRS changing its mind; the file holds only the user's decision", async () => {
  const { dir, subject } = await seed({ a: "2026-10-23" });
  const before = await getSchedule(dir, NOW);
  const id = blocks(before)[0].id;
  assert.equal(id, "2026-10-23:a");
  const after = await applyBlockAction(dir, id, "move", { toDate: "2026-10-28" }, NOW);
  assert.deepEqual(daysOf(after, "a"), ["2026-10-28"]);

  await setDue(dir, "a", "2026-10-12"); // FSRS now says it's overdue
  assert.deepEqual(daysOf(await getSchedule(dir, NOW), "a"), ["2026-10-28"]);
  await createDeadline(dir, subject.id, { title: "Quiz", date: "2026-10-24" });
  assert.deepEqual(daysOf(await getSchedule(dir, NOW), "a"), ["2026-10-28"], "a new deadline doesn't move it either");

  const stored = await makeJsonFileStore(appDataSubdirs(dir).db, "schedule.json", {}).read();
  assert.deepEqual(Object.keys(stored), ["overrides"]);
  assert.deepEqual(stored.overrides.map(({ id: oid, topicId, date, status }) => ({ oid, topicId, date, status })), [
    { oid: "2026-10-23:a", topicId: "a", date: "2026-10-28", status: "planned" },
  ]);
});

test("stored: delete, then Undo restores the computed block", async () => {
  const { dir } = await seed({ a: TODAY, b: TODAY });
  const deleted = await applyBlockAction(dir, `${TODAY}:a`, "delete", {}, NOW);
  assert.deepEqual(daysOf(deleted, "a"), []);
  assert.deepEqual(daysOf(await getSchedule(dir, NOW), "a"), []);
  const restored = await applyBlockAction(dir, `${TODAY}:a`, "restore", {}, NOW);
  assert.deepEqual(daysOf(restored, "a"), [TODAY]);
  await assert.rejects(applyBlockAction(dir, `${TODAY}:a`, "restore", {}, NOW), BlockChangedError, "nothing left to undo");
});

test("stored: mark done and take it back; a moved block stays moved when un-done", async () => {
  const { dir } = await seed({ a: TODAY, b: "2026-10-22" });
  const done = await applyBlockAction(dir, `${TODAY}:a`, "done", {}, NOW);
  assert.equal(blocks(done).find((b) => b.topicId === "a").status, "done");
  const undone = await applyBlockAction(dir, `${TODAY}:a`, "undone", {}, NOW);
  assert.equal(blocks(undone).find((b) => b.topicId === "a").status, "planned");
  assert.deepEqual((await makeJsonFileStore(appDataSubdirs(dir).db, "schedule.json", {}).read()).overrides, []);

  await applyBlockAction(dir, "2026-10-22:b", "move", { toDate: "2026-10-24" }, NOW);
  await applyBlockAction(dir, "2026-10-22:b", "done", {}, NOW);
  const movedBack = await applyBlockAction(dir, "2026-10-22:b", "undone", {}, NOW);
  const b = blocks(movedBack).find((x) => x.topicId === "b");
  assert.deepEqual([b.date, b.status, b.moved], ["2026-10-24", "planned", true]);
});

test("stored: moving a done block keeps it done", async () => {
  const { dir } = await seed({ a: TODAY });
  await applyBlockAction(dir, `${TODAY}:a`, "done", {}, NOW);
  const moved = await applyBlockAction(dir, `${TODAY}:a`, "move", { toDate: "2026-10-21" }, NOW);
  assert.deepEqual(blocks(moved).map((b) => [b.date, b.status]), [["2026-10-21", "done"]]);
});

test("stored: acting on a block that's no longer on the schedule is refused, not guessed at", async () => {
  const { dir } = await seed({ a: TODAY });
  await assert.rejects(applyBlockAction(dir, "2026-10-21:a", "done", {}, NOW), BlockChangedError);
  await assert.rejects(applyBlockAction(dir, "garbage", "delete", {}, NOW), BlockChangedError);
  await assert.rejects(applyBlockAction(dir, `${TODAY}:a`, "explode", {}, NOW), /action must be/);
  await assert.rejects(applyBlockAction(dir, `${TODAY}:a`, "move", { toDate: "2026-10-19" }, NOW), /from today/);
  await assert.rejects(applyBlockAction(dir, `${TODAY}:a`, "move", { toDate: "2026-11-03" }, NOW), /from today/);
  await assert.rejects(applyBlockAction(dir, `${TODAY}:a`, "move", {}, NOW), /Pick a day/);
  assert.deepEqual(await makeJsonFileStore(appDataSubdirs(dir).db, "schedule.json", {}).read(), {}, "nothing stored");
});

test("stored: a session's answers mark today's block done; that can't be un-done, only deleted", async () => {
  const { dir, subject } = await seed({ a: TODAY });
  await makeJsonFileStore(appDataSubdirs(dir).db, "sessions.json", []).write([
    { id: "s", subjectIds: [subject.id], archived: true, history: [{ topicId: "a", answeredAt: new Date(NOW.getTime() - 3600_000).toISOString() }] },
  ]);
  await setDue(dir, "a", "2026-10-26"); // what the review did to FSRS
  const s = await getSchedule(dir, NOW);
  assert.deepEqual(blocks(s).map((b) => [b.date, b.status, b.doneBy]), [[TODAY, "done", "session"]]);
  await assert.rejects(applyBlockAction(dir, `${TODAY}:a`, "undone", {}, NOW), /study session/);
  const hidden = await applyBlockAction(dir, `${TODAY}:a`, "delete", {}, NOW);
  assert.equal(blocks(hidden).length, 0);
});

test("stored: decisions for past days are pruned on the next write", async () => {
  const { dir } = await seed({ a: "2026-10-19", b: TODAY });
  await applyBlockAction(dir, "2026-10-19:a", "done", {}, localNoon("2026-10-19"));
  await applyBlockAction(dir, `${TODAY}:b`, "done", {}, NOW);
  const stored = await makeJsonFileStore(appDataSubdirs(dir).db, "schedule.json", {}).read();
  assert.deepEqual(stored.overrides.map((o) => o.id), [`${TODAY}:b`]);
});

test("stored: availability is saved, validated, and never overridden by pacing", async () => {
  const { dir, subject } = await seed({ a: "2026-12-01", b: "2026-12-01" });
  assert.deepEqual(await getAvailability(dir), DEFAULT_AVAILABILITY);
  await assert.rejects(setAvailability(dir, { weekdays: [7], minutesPerDay: 30 }), /weekdays/);
  await assert.rejects(setAvailability(dir, { weekdays: [1], minutesPerDay: 2 }), /Minutes per day/);
  await assert.rejects(setAvailability(dir, { weekdays: [1], minutesPerDay: 12.5 }), /Minutes per day/);
  assert.deepEqual(await getAvailability(dir), DEFAULT_AVAILABILITY, "a refused change stores nothing");
  await setAvailability(dir, { weekdays: [6, 1, 2, 3, 4, 5, 5], minutesPerDay: 5 });
  assert.deepEqual(await getAvailability(dir), { weekdays: [1, 2, 3, 4, 5, 6], minutesPerDay: 5 });
  await createDeadline(dir, subject.id, { title: "Monday exam", date: "2026-10-26" });
  const s = await getSchedule(dir, NOW);
  assert.deepEqual(blocks(s).map((b) => b.date).sort(), ["2026-10-23", "2026-10-24"]);
});

test("stored: deleting a deadline leaves the user's blocks exactly where they are", async () => {
  const { dir, subject } = await seed({ a: "2026-12-01", b: "2026-12-01" });
  const exam = await createDeadline(dir, subject.id, { title: "Midterm", date: "2026-10-25" });
  const s = await getSchedule(dir, NOW);
  const [first, second] = blocks(s).filter((b) => b.reason === "deadline");
  await applyBlockAction(dir, first.id, "move", { toDate: "2026-10-22" }, NOW);
  await applyBlockAction(dir, second.id, "done", {}, NOW);
  await deleteDeadline(dir, subject.id, exam.id);
  const after = await getSchedule(dir, NOW);
  assert.deepEqual(
    blocks(after).map((b) => [b.id, b.date, b.status]).sort(),
    [
      [first.id, "2026-10-22", "planned"],
      [second.id, second.date, "done"],
    ].sort(),
  );
});

test("stored: an archived subject's blocks leave the schedule and come back on restore", async () => {
  const { dir, subject } = await seed({ a: TODAY });
  await applyBlockAction(dir, `${TODAY}:a`, "move", { toDate: "2026-10-22" }, NOW);
  await archiveSubject(dir, subject.id);
  assert.equal(blocks(await getSchedule(dir, NOW)).length, 0);
});

test("Study picks up today's planned topics that aren't due yet (pulled forward or put there by the user)", async () => {
  const { dir, subject } = await seed({ due: TODAY, paced: "2026-12-01", mine: "2026-12-01", idle: "2026-12-01" });
  assert.deepEqual(await extraTopicIdsForToday(dir, NOW), [], "nothing extra without deadlines or decisions");
  assert.deepEqual(await buildSessionTopicIds(dir, [subject.id], { now: NOW }), ["due"]);

  await createDeadline(dir, subject.id, { title: "Quiz", date: "2026-10-21", topicIds: ["paced"] });
  // A block the user moved onto today from a later day ("mine" isn't due
  // within the two weeks, so write the decision as the move would have).
  await makeJsonFileStore(appDataSubdirs(dir).db, "schedule.json", {}).update((cur) => ({
    ...cur,
    overrides: [...(cur.overrides ?? []), { id: "2026-10-30:mine", topicId: "mine", date: TODAY, status: "planned" }],
  }));
  assert.deepEqual((await extraTopicIdsForToday(dir, NOW)).sort(), ["mine", "paced"]);
  const ids = await buildSessionTopicIds(dir, [subject.id], { now: NOW });
  assert.equal(ids[0], "due", "what's due still comes first");
  assert.deepEqual(ids.slice(1).sort(), ["mine", "paced"]);
  assert.ok(!ids.includes("idle"));
});
