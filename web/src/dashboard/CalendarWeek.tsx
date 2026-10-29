import { useEffect, useRef, useState } from "react";
import type { Schedule, ScheduleBlock, ScheduleDay } from "./api";
import { addDays, daysBetween, formatDay, parseLocalDate, WEEKDAY_SHORT, weekStart } from "./calendarDates";

// Issue #23: the Calendar's plan a week at a time, as seven day columns
// (Monday first) instead of a list. Study blocks have no times of day,
// only a day, so each column stacks that day's deadlines and topics
// rather than placing them on an hour grid. Topics are grouped by
// subject; changing them happens in the list, which "Open day" jumps to.
export function CalendarWeek({ schedule, onOpenDay }: { schedule: Schedule; onOpenDay: (date: string) => void }) {
  const first = weekStart(schedule.today);
  const lastPlanned = schedule.days[schedule.days.length - 1]?.date ?? schedule.today;
  const weekCount = daysBetween(first, weekStart(lastPlanned)) / 7 + 1;
  const [weekIndex, setWeekIndex] = useState(0);
  const start = addDays(first, weekIndex * 7);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const byDate = new Map(schedule.days.map((d) => [d.date, d]));
  const grid = useRef<HTMLDivElement>(null);

  // On a narrow screen the columns scroll sideways: start this week at
  // today rather than at Monday's past days.
  useEffect(() => {
    const today = grid.current?.querySelector<HTMLElement>(".calendar-week-today");
    if (grid.current && today && grid.current.scrollWidth > grid.current.clientWidth) {
      grid.current.scrollLeft = today.offsetLeft - grid.current.offsetLeft;
    }
  }, [weekIndex]);

  return (
    <section className="calendar-week" aria-label={`Week of ${formatDay(start)}`}>
      <div className="calendar-week-nav">
        <button type="button" className="btn-secondary" disabled={weekIndex === 0} onClick={() => setWeekIndex((i) => i - 1)}>
          Previous week
        </button>
        <h2>
          {formatDay(dates[0])} – {formatDay(dates[6])}
        </h2>
        <button type="button" className="btn-secondary" disabled={weekIndex >= weekCount - 1} onClick={() => setWeekIndex((i) => i + 1)}>
          Next week
        </button>
      </div>
      <div className="calendar-week-grid" ref={grid}>
        {dates.map((date) => (
          <WeekDay key={date} date={date} day={byDate.get(date) ?? null} today={schedule.today} onOpenDay={onOpenDay} />
        ))}
      </div>
    </section>
  );
}

function WeekDay({ date, day, today, onOpenDay }: { date: string; day: ScheduleDay | null; today: string; onOpenDay: (date: string) => void }) {
  const weekday = WEEKDAY_SHORT[parseLocalDate(date)?.getDay() ?? 0];
  const dayNumber = Number(date.slice(8));
  const classes = ["calendar-week-day"];
  if (date === today) classes.push("calendar-week-today");
  if (!day || !day.available) classes.push("calendar-week-off");

  let empty: string | null = null;
  if (!day) empty = date < today ? "Past" : "Not planned yet";
  else if (!day.available && day.blocks.length === 0) empty = "Day off";
  else if (day.blocks.length === 0) empty = "Nothing planned";

  return (
    <div className={classes.join(" ")} role="group" aria-label={formatDay(date)}>
      <div className="calendar-week-day-header">
        <span className="calendar-week-weekday">{weekday}</span>
        <span className="calendar-week-date">{dayNumber}</span>
      </div>
      {day?.deadlines.map((d) => (
        <div key={d.id} className="calendar-week-deadline" title={`${d.title} · ${d.subjectName}`}>
          {d.title}
        </div>
      ))}
      {empty && <div className="calendar-week-empty">{empty}</div>}
      {day && groupBySubject(day.blocks).map((group) => <WeekSubject key={group.subjectId} {...group} />)}
      {day && day.blocks.length > 0 && (
        <button type="button" className="calendar-week-open" onClick={() => onOpenDay(date)}>
          Open day
        </button>
      )}
    </div>
  );
}

export type SubjectBlocks = { subjectId: string; subjectName: string; blocks: ScheduleBlock[] };

/** A day's blocks grouped by subject, in the order subjects first appear. */
export function groupBySubject(blocks: ScheduleBlock[]): SubjectBlocks[] {
  const groups = new Map<string, SubjectBlocks>();
  for (const block of blocks) {
    const group = groups.get(block.subjectId) ?? { subjectId: block.subjectId, subjectName: block.subjectName, blocks: [] };
    group.blocks.push(block);
    groups.set(block.subjectId, group);
  }
  return [...groups.values()];
}

function WeekSubject({ subjectName, blocks }: { subjectName: string; blocks: ScheduleBlock[] }) {
  const [open, setOpen] = useState(false);
  const done = blocks.filter((b) => b.status === "done").length;
  return (
    <div className={done === blocks.length ? "calendar-week-subject calendar-week-subject-done" : "calendar-week-subject"}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="calendar-week-subject-name">{subjectName}</span>
        <span className="calendar-week-subject-count">
          {done ? `${done}/${blocks.length}` : blocks.length}
        </span>
      </button>
      {open && (
        <ul>
          {blocks.map((b) => (
            <li key={b.id} className={b.status === "done" ? "calendar-week-topic-done" : undefined}>
              {b.topicName}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
