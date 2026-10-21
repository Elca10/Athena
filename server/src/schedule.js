// The suggested study schedule behind the Calendar button (SPEC.md section
// 9, SPEC-v2.md section 2 and its owner calendar decisions). Which topics
// to study on which day, for the next HORIZON_DAYS days, derived by plain
// code from the FSRS due dates, deadlines and the user's availability. No
// model calls, and nothing computed is ever stored: every request
// recomputes from current state, so a missed day simply isn't there any
// more the next day (nothing to "catch up").
//
// The user's decisions win (owner decision, 2026-10-19). That is the
// whole shape of this module:
//   - A block is one topic on one day. Its id is "<originDate>:<topicId>",
//     the day the schedule first put it on, so it stays the same block
//     when the user moves it.
//   - What the user does to a block (move, delete, mark done) is stored as
//     an OVERRIDE keyed by that id, in schedule.json. Availability lives
//     there too. Nothing but a user action writes that file.
//   - Every computation starts from the overrides: a topic the user has
//     made a decision about (an override still on today or later) is
//     "claimed", so the computed schedule never places it again, and the
//     user's blocks take their day's time first. The computed schedule
//     only fills the room that's left, on the days availability allows.
//   - The final list is built with the overrides applied last, so even a
//     bug in the computed part can't put a computed block in place of a
//     user's one.
// Overrides for days that have passed are inert and pruned on the next
// write.
//
// Scheduling rule, in order:
//   1. Blocks from the user's own decisions (moved/done; deleted ones take
//      no time but still claim their topic until their day passes).
//   2. Topics already studied today in a real session show as done today
//      (that is the "marked done automatically" part).
//   3. Topics covered by an upcoming deadline the user is studying for
//      (exam-aware pacing): they must be reviewed before the deadline day.
//      Each goes on min(its FSRS due day, the day before the deadline);
//      if that day is full or unavailable, the nearest earlier free day,
//      then any later free day still before the deadline. A topic that
//      fits nowhere is reported as unscheduled for that deadline, never
//      squeezed onto a day off or past the minutes the user set.
//      Deadlines are paced soonest first.
//   4. Every other topic goes on its FSRS due day (today if overdue), or
//      the next day with room.
// "Room" is the user's minutes per day divided by MINUTES_PER_BLOCK, and
// only on the weekdays they picked.

import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";
import { listSubjects } from "./subjects.js";
import { listTopics } from "./topics.js";
import { listSessions } from "./sessions.js";
import { listAllDeadlines, coveredTopicIds } from "./deadlines.js";
import { addDays, isValidDateString, localDateOf, weekdayOf } from "./localDate.js";

const FILE_NAME = "schedule.json";

/** How many days the Calendar shows, starting today. */
export const HORIZON_DAYS = 14;
/** Deadlines further out than this aren't paced yet (keeps every request
 * cheap); they come into range as the date gets closer. */
export const MAX_PLAN_DAYS = 120;
/** Rough time one topic takes in a session: one question, a confidence
 * rating and the feedback. Ada's call; no number is given in the spec. */
export const MINUTES_PER_BLOCK = 5;
export const DEFAULT_AVAILABILITY = Object.freeze({ weekdays: [0, 1, 2, 3, 4, 5, 6], minutesPerDay: 30 });
export const MIN_MINUTES_PER_DAY = MINUTES_PER_BLOCK;
export const MAX_MINUTES_PER_DAY = 600;

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, {});
}

export function blockId(originDate, topicId) {
  return `${originDate}:${topicId}`;
}

/** Splits a block id back into its parts, or null if it isn't one. */
export function parseBlockId(id) {
  if (typeof id !== "string") return null;
  const sep = id.indexOf(":");
  if (sep === -1) return null;
  const originDate = id.slice(0, sep);
  const topicId = id.slice(sep + 1);
  if (!isValidDateString(originDate) || !topicId) return null;
  return { originDate, topicId };
}

export function normalizeAvailability(value) {
  const weekdays = Array.isArray(value?.weekdays)
    ? [...new Set(value.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    : [...DEFAULT_AVAILABILITY.weekdays];
  const minutes = Number.isInteger(value?.minutesPerDay) ? value.minutesPerDay : DEFAULT_AVAILABILITY.minutesPerDay;
  return { weekdays, minutesPerDay: Math.min(MAX_MINUTES_PER_DAY, Math.max(MIN_MINUTES_PER_DAY, minutes)) };
}

/** Blocks a day with these settings holds: at least one on a study day. */
export function blocksPerDay(availability) {
  return Math.max(1, Math.floor(availability.minutesPerDay / MINUTES_PER_BLOCK));
}

/**
 * Pure: the whole schedule from plain data. Exported so the "user
 * decisions win" rules can be tested without a data dir.
 *   today        YYYY-MM-DD (the user's local date)
 *   subjects     active (not archived) subjects: {id, name}
 *   topics       their topics: {id, subjectId, name, fsrs: {due}}
 *   deadlines    all deadlines (inactive subjects' are ignored)
 *   availability normalized availability
 *   overrides    the stored user decisions
 *   studied      Set of "<date>:<topicId>" a real session answered
 */
export function computeSchedule({
  today,
  subjects,
  topics,
  deadlines = [],
  availability = DEFAULT_AVAILABILITY,
  overrides = [],
  studied = new Set(),
  horizonDays = HORIZON_DAYS,
}) {
  const subjectsById = new Map(subjects.map((s) => [s.id, s]));
  const topicsById = new Map(topics.filter((t) => subjectsById.has(t.subjectId)).map((t) => [t.id, t]));
  const horizonEnd = addDays(today, horizonDays - 1);
  const perDay = blocksPerDay(availability);
  const studyDays = new Set(availability.weekdays);

  // Deadlines the user is studying for, from tomorrow (a deadline today
  // can't be studied *before*) up to MAX_PLAN_DAYS out.
  const maxEnd = addDays(today, MAX_PLAN_DAYS - 1);
  const upcoming = deadlines
    .filter((d) => subjectsById.has(d.subjectId) && d.studying && d.date > today && addDays(d.date, -1) <= maxEnd)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let planEnd = horizonEnd;
  for (const d of upcoming) if (addDays(d.date, -1) > planEnd) planEnd = addDays(d.date, -1);

  const room = new Map();
  for (let day = today; day <= planEnd; day = addDays(day, 1)) {
    room.set(day, studyDays.has(weekdayOf(day)) ? perDay : 0);
  }
  const takeRoom = (day) => room.has(day) && room.set(day, room.get(day) - 1);

  const blockFor = (topic, date, extra) => {
    const subject = subjectsById.get(topic.subjectId);
    return {
      id: blockId(date, topic.id),
      topicId: topic.id,
      topicName: topic.name,
      subjectId: subject.id,
      subjectName: subject.name,
      date,
      status: "planned",
      doneBy: null,
      moved: false,
      byYou: false,
      reason: "due",
      deadline: null,
      ...extra,
    };
  };

  // 1. The user's decisions. Only overrides still on today or later count;
  // older ones are history, and their topic is free to be planned again.
  const activeOverrides = overrides
    .filter((o) => o && o.date >= today && topicsById.has(o.topicId))
    .sort((a, b) => a.id.localeCompare(b.id));
  const activeOverrideIds = new Set(activeOverrides.map((o) => o.id));
  const claimed = new Set();
  const userBlocks = [];
  for (const o of activeOverrides) {
    claimed.add(o.topicId);
    if (o.status === "deleted") continue;
    const studiedThatDay = studied.has(`${o.date}:${o.topicId}`);
    const done = o.status === "done" || studiedThatDay;
    userBlocks.push(
      blockFor(topicsById.get(o.topicId), o.date, {
        id: o.id,
        status: done ? "done" : "planned",
        doneBy: o.status === "done" ? "you" : studiedThatDay ? "session" : null,
        moved: o.date !== parseBlockId(o.id)?.originDate,
        byYou: true,
        reason: "you",
      }),
    );
    takeRoom(o.date);
  }

  // 2. Studied today in a real session: done, automatically.
  const sessionBlocks = [];
  for (const key of [...studied].sort()) {
    const parsed = parseBlockId(key);
    if (!parsed || parsed.originDate !== today) continue;
    const topic = topicsById.get(parsed.topicId);
    if (!topic || activeOverrideIds.has(key)) continue;
    if (userBlocks.some((b) => b.topicId === topic.id && b.date === today)) continue;
    claimed.add(topic.id);
    sessionBlocks.push(blockFor(topic, today, { status: "done", doneBy: "session", reason: "studied" }));
    takeRoom(today);
  }

  // 3 + 4. Everything else, computed around the above.
  const firstDeadlineFor = new Map();
  for (const d of upcoming) {
    const subjectTopics = topics.filter((t) => t.subjectId === d.subjectId);
    for (const topicId of coveredTopicIds(d, subjectTopics)) {
      if (!firstDeadlineFor.has(topicId)) firstDeadlineFor.set(topicId, d);
    }
  }
  const dueDay = (topic) => {
    const due = topic.fsrs?.due;
    const day = typeof due === "number" && Number.isFinite(due) ? localDateOf(due) : today;
    return day < today ? today : day;
  };
  const free = [...topicsById.values()].filter((t) => !claimed.has(t.id));
  const byDue = (a, b) => (a.fsrs?.due ?? 0) - (b.fsrs?.due ?? 0) || a.id.localeCompare(b.id);
  const paced = free
    .filter((t) => firstDeadlineFor.has(t.id))
    .sort((a, b) => firstDeadlineFor.get(a.id).date.localeCompare(firstDeadlineFor.get(b.id).date) || byDue(a, b));
  const regular = free.filter((t) => !firstDeadlineFor.has(t.id)).sort(byDue);
  const hasRoom = (day) => (room.get(day) ?? 0) > 0;

  const computed = [];
  const unscheduledByDeadline = new Map();
  for (const topic of paced) {
    const deadline = firstDeadlineFor.get(topic.id);
    const lastDay = addDays(deadline.date, -1);
    const due = dueDay(topic);
    const preferred = due < lastDay ? due : lastDay;
    let placed = null;
    for (let day = preferred; day >= today && !placed; day = addDays(day, -1)) if (hasRoom(day)) placed = day;
    for (let day = addDays(preferred, 1); day <= lastDay && !placed; day = addDays(day, 1)) {
      if (hasRoom(day)) placed = day;
    }
    if (!placed) {
      unscheduledByDeadline.set(deadline.id, (unscheduledByDeadline.get(deadline.id) ?? 0) + 1);
      continue;
    }
    takeRoom(placed);
    computed.push(
      blockFor(topic, placed, {
        reason: due > lastDay ? "deadline" : "due",
        deadline: { id: deadline.id, title: deadline.title, date: deadline.date },
      }),
    );
  }
  for (const topic of regular) {
    for (let day = dueDay(topic); day <= horizonEnd; day = addDays(day, 1)) {
      if (hasRoom(day)) {
        takeRoom(day);
        computed.push(blockFor(topic, day));
        break;
      }
    }
  }

  // Applied last: a user's decision about a block always replaces
  // whatever the computation produced for it.
  const finalBlocks = [
    ...computed.filter((b) => !activeOverrideIds.has(b.id) && !claimed.has(b.topicId)),
    ...sessionBlocks,
    ...userBlocks,
  ].filter((b) => b.date >= today && b.date <= horizonEnd);

  const statusOrder = (b) => (b.status === "done" ? 1 : 0);
  const days = [];
  for (let day = today; day <= horizonEnd; day = addDays(day, 1)) {
    days.push({
      date: day,
      weekday: weekdayOf(day),
      available: studyDays.has(weekdayOf(day)),
      blocks: finalBlocks
        .filter((b) => b.date === day)
        .sort(
          (a, b) =>
            statusOrder(a) - statusOrder(b) ||
            a.subjectName.localeCompare(b.subjectName) ||
            a.topicName.localeCompare(b.topicName) ||
            a.id.localeCompare(b.id),
        ),
      deadlines: deadlines
        .filter((d) => d.date === day && subjectsById.has(d.subjectId))
        .map((d) => ({ id: d.id, title: d.title, subjectId: d.subjectId, subjectName: subjectsById.get(d.subjectId).name, studying: d.studying })),
    });
  }

  const unscheduled = upcoming
    .filter((d) => unscheduledByDeadline.has(d.id))
    .map((d) => ({
      deadlineId: d.id,
      title: d.title,
      date: d.date,
      subjectId: d.subjectId,
      subjectName: subjectsById.get(d.subjectId).name,
      topicCount: unscheduledByDeadline.get(d.id),
    }));

  return { today, horizonDays, availability, minutesPerBlock: MINUTES_PER_BLOCK, blocksPerDay: perDay, days, unscheduled };
}

async function readState(appDataDir) {
  const raw = await storeFor(appDataDir).read();
  return {
    availability: normalizeAvailability(raw?.availability),
    overrides: Array.isArray(raw?.overrides) ? raw.overrides : [],
  };
}

/** "<date>:<topicId>" for every question a real session answered on or
 * after `today` (only today can actually have any). */
function studiedKeys(sessions, today) {
  const keys = new Set();
  for (const s of sessions) {
    for (const entry of s.history ?? []) {
      if (!entry?.topicId || !entry.answeredAt) continue;
      const day = localDateOf(entry.answeredAt);
      if (day >= today) keys.add(`${day}:${entry.topicId}`);
    }
  }
  return keys;
}

async function gatherInputs(appDataDir, today) {
  const subjects = await listSubjects(appDataDir);
  const topics = [];
  for (const s of subjects) topics.push(...(await listTopics(appDataDir, s.id)));
  const [deadlines, state, sessions] = await Promise.all([
    listAllDeadlines(appDataDir),
    readState(appDataDir),
    listSessions(appDataDir, { includeArchived: true }),
  ]);
  return {
    today,
    subjects,
    topics,
    deadlines,
    availability: state.availability,
    overrides: state.overrides,
    studied: studiedKeys(sessions, today),
  };
}

export async function getSchedule(appDataDir, now = new Date()) {
  return computeSchedule(await gatherInputs(appDataDir, localDateOf(now)));
}

/**
 * Topic ids planned for today that a plain "what's due" pick would miss:
 * pulled forward for a deadline, or put on today by the user. The Study
 * button adds these, so following the schedule is just pressing Study.
 * Free when there are no deadlines and no user decisions at all.
 */
export async function extraTopicIdsForToday(appDataDir, now = new Date()) {
  const [deadlines, state] = await Promise.all([listAllDeadlines(appDataDir), readState(appDataDir)]);
  if (!deadlines.some((d) => d.studying) && state.overrides.length === 0) return [];
  const schedule = await getSchedule(appDataDir, now);
  return schedule.days[0].blocks
    .filter((b) => b.status === "planned" && (b.reason === "deadline" || b.byYou))
    .map((b) => b.topicId);
}

export async function getAvailability(appDataDir) {
  return (await readState(appDataDir)).availability;
}

export async function setAvailability(appDataDir, value) {
  if (!Array.isArray(value?.weekdays) || value.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new Error("weekdays must be a list of day numbers, 0 (Sunday) to 6 (Saturday).");
  }
  if (!Number.isInteger(value?.minutesPerDay) || value.minutesPerDay < MIN_MINUTES_PER_DAY || value.minutesPerDay > MAX_MINUTES_PER_DAY) {
    throw new Error(`Minutes per day must be a whole number from ${MIN_MINUTES_PER_DAY} to ${MAX_MINUTES_PER_DAY}.`);
  }
  const availability = normalizeAvailability(value);
  await storeFor(appDataDir).update((current) => ({ ...(current ?? {}), availability }));
  return availability;
}

export const BLOCK_ACTIONS = ["done", "undone", "move", "delete", "restore"];

export class BlockChangedError extends Error {}

/**
 * Applies one user decision to the block with this id, as the schedule
 * shows it right now. A block that isn't there any more (another tab
 * changed it, the topic was removed, the day passed) throws
 * BlockChangedError so the UI can refresh instead of acting on a stale
 * view. Returns the new schedule.
 *   done     mark done (stays on its day)
 *   undone   take back a "done" the user set (a moved block stays moved)
 *   move     put it on `toDate` (today .. end of the horizon)
 *   delete   remove it; that topic isn't planned again until that day passes
 *   restore  take back a delete (or any decision): back to the computed plan
 */
export async function applyBlockAction(appDataDir, id, action, { toDate } = {}, now = new Date()) {
  if (!BLOCK_ACTIONS.includes(action)) throw new Error(`action must be one of ${BLOCK_ACTIONS.join(", ")}`);
  const today = localDateOf(now);
  const parsed = parseBlockId(id);
  if (!parsed) throw new BlockChangedError("That study block isn't on your schedule any more.");

  const inputs = await gatherInputs(appDataDir, today);
  const schedule = computeSchedule(inputs);
  const block = schedule.days.flatMap((d) => d.blocks).find((b) => b.id === id);
  const existing = inputs.overrides.find((o) => o.id === id && o.date >= today);

  if (action === "restore") {
    if (!existing) throw new BlockChangedError("There's nothing to undo for that study block any more.");
  } else if (!block) {
    throw new BlockChangedError("That study block isn't on your schedule any more. The schedule has been refreshed.");
  }
  if (action === "undone" && block.doneBy === "session") {
    throw new Error("This one was done in a study session, so it stays done. Delete it if you don't want it shown.");
  }
  if (action === "move") {
    if (!isValidDateString(toDate)) throw new Error("Pick a day to move it to.");
    const horizonEnd = addDays(today, schedule.horizonDays - 1);
    if (toDate < today || toDate > horizonEnd) throw new Error("You can move a block to any day from today to the end of the schedule.");
  }

  let record = null;
  if (action === "done") record = { status: "done", date: block.date };
  if (action === "delete") record = { status: "deleted", date: block.date };
  if (action === "move") record = { status: existing?.status === "done" ? "done" : "planned", date: toDate };
  if (action === "undone") record = block.moved ? { status: "planned", date: block.date } : null;

  await storeFor(appDataDir).update((current) => {
    const overrides = (Array.isArray(current?.overrides) ? current.overrides : []).filter(
      (o) => o && o.id !== id && o.date >= today,
    );
    if (record) {
      overrides.push({ id, topicId: parsed.topicId, ...record, updatedAt: now.toISOString() });
    }
    return { ...(current ?? {}), overrides };
  });
  return getSchedule(appDataDir, now);
}
