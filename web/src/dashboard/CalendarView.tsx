import { useEffect, useState } from "react";
import {
  getSchedule,
  saveAvailability,
  scheduleBlockAction,
  type Availability,
  type BlockAction,
  type Schedule,
  type ScheduleBlock,
} from "./api";
import { dayHeading, formatDay, WEEKDAY_NAMES, WEEKDAY_ORDER, WEEKDAY_SHORT } from "./calendarDates";
import { AppearanceMenu } from "../theme/AppearanceMenu";

// The Calendar (SPEC.md section 9, SPEC-v2.md section 2): the suggested
// schedule for the next two weeks, worked out on the server from what's
// due, the deadlines being studied for, and the user's study days
// (server/src/schedule.js). A full view like Archive, with "Back to
// dashboard" as its exit.
//
// Everything the user does here is a decision the schedule then keeps:
// marking a block done, moving it, deleting it, and the study days and
// minutes. The server returns the fresh schedule after each one, and if a
// block had already changed (a session covered it in another tab, the day
// rolled over) it says so and shows the current schedule instead.
export function CalendarView({ onBack }: { onBack: () => void }) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean; undoId?: string } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [availabilityDirty, setAvailabilityDirty] = useState(false);

  async function load() {
    setLoadError(null);
    try {
      setSchedule(await getSchedule());
    } catch {
      setLoadError("Couldn't load your schedule. Athena may be restarting. Wait a moment, then try again.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  function leave() {
    if (availabilityDirty && !window.confirm("Leave without saving your study days?")) return;
    onBack();
  }

  async function act(block: ScheduleBlock, action: BlockAction, toDate?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await scheduleBlockAction(block.id, action, toDate);
      if (result.schedule) setSchedule(result.schedule);
      setMovingId(null);
      if (!result.ok) {
        setMessage({ text: result.error, ok: false });
      } else if (action === "delete") {
        setMessage({ text: `Removed ${block.topicName} from ${formatDay(block.date)}.`, ok: true, undoId: block.id });
      } else if (action === "move" && toDate) {
        setMessage({ text: `Moved ${block.topicName} to ${formatDay(toDate)}.`, ok: true });
      }
    } catch {
      setMessage({ text: "Couldn't reach Athena. Check it's still running, then try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function undoDelete(blockId: string) {
    setBusy(true);
    try {
      const result = await scheduleBlockAction(blockId, "restore");
      if (result.schedule) setSchedule(result.schedule);
      setMessage(result.ok ? { text: "Put it back.", ok: true } : { text: result.error, ok: false });
    } catch {
      setMessage({ text: "Couldn't reach Athena. Check it's still running, then try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  const allBlocks = schedule?.days.flatMap((d) => d.blocks) ?? [];
  const nothingPlanned = schedule !== null && allBlocks.length === 0;

  return (
    <div className="dashboard calendar-view">
      <header className="dashboard-header">
        <div className="dashboard-header-top">
          <h1>Calendar</h1>
          <div className="dashboard-header-actions">
            <AppearanceMenu />
            <button type="button" onClick={leave}>
              Back to dashboard
            </button>
          </div>
        </div>
        <p className="calendar-intro">
          Your suggested study plan for the next two weeks, from what's due and the deadlines you're studying for. It
          rebuilds itself every time, so a missed day never piles up. Anything you move, delete or mark done stays the
          way you left it.
        </p>
      </header>

      {loadError && (
        <div className="dashboard-load-error" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {!loadError && schedule === null && <div className="dashboard-empty">Loading your schedule…</div>}

      {schedule && (
        <div className="calendar-body">
          <AvailabilityForm
            availability={schedule.availability}
            minutesPerBlock={schedule.minutesPerBlock}
            onDirtyChange={setAvailabilityDirty}
            onSaved={(next) => {
              setSchedule(next);
              setMessage({ text: "Saved. The plan now uses your new study days.", ok: true });
            }}
          />

          {message && (
            <div className={message.ok ? "dashboard-notice" : "dashboard-notice dashboard-notice-error"} role={message.ok ? "status" : "alert"}>
              <span>{message.text}</span>
              {message.undoId && (
                <button type="button" disabled={busy} onClick={() => undoDelete(message.undoId!)}>
                  Undo
                </button>
              )}
              <button type="button" onClick={() => setMessage(null)}>
                Dismiss
              </button>
            </div>
          )}

          {schedule.unscheduled.map((u) => (
            <div key={u.deadlineId} className="dashboard-notice dashboard-notice-error" role="alert">
              <span>
                {u.topicCount} topic{u.topicCount === 1 ? "" : "s"} for {u.title} ({u.subjectName}, {formatDay(u.date)}){" "}
                {u.topicCount === 1 ? "doesn't" : "don't"} fit before the date. Add study days or minutes above, or
                untick "Study for this" on deadlines you don't need.
              </span>
            </div>
          ))}

          {schedule.availability.weekdays.length === 0 && (
            <div className="dashboard-empty">You haven't picked any study days, so nothing is planned. Pick some above.</div>
          )}
          {nothingPlanned && schedule.availability.weekdays.length > 0 && (
            <div className="dashboard-empty">
              Nothing to plan for the next two weeks. Add content to a subject so Athena has topics to quiz you on, or add a
              deadline by clicking a subject's name on the dashboard.
            </div>
          )}

          <ol className="calendar-days">
            {schedule.days.map((day) => {
              const minutes = day.blocks.filter((b) => b.status === "planned").length * schedule.minutesPerBlock;
              return (
                <li key={day.date} className={day.available ? "calendar-day" : "calendar-day calendar-day-off"}>
                  <div className="calendar-day-header">
                    <h2>{dayHeading(day.date, schedule.today)}</h2>
                    <span className="calendar-day-meta">
                      {!day.available ? "Day off" : minutes ? `about ${minutes} min to go` : day.blocks.length ? "All done" : ""}
                    </span>
                  </div>
                  {day.deadlines.map((d) => (
                    <div key={d.id} className="calendar-deadline">
                      Deadline: <strong>{d.title}</strong> · {d.subjectName}
                      {!d.studying && <span className="calendar-tag">not studying for it</span>}
                    </div>
                  ))}
                  {day.blocks.length === 0 && day.available && <div className="calendar-day-empty">Nothing planned.</div>}
                  {day.blocks.length > 0 && (
                    <ul className="calendar-blocks">
                      {day.blocks.map((block) => (
                        <BlockRow
                          key={block.id}
                          block={block}
                          schedule={schedule}
                          busy={busy}
                          moving={movingId === block.id}
                          onStartMove={() => setMovingId(block.id)}
                          onCancelMove={() => setMovingId(null)}
                          onAction={(action, toDate) => act(block, action, toDate)}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

function BlockRow({
  block,
  schedule,
  busy,
  moving,
  onStartMove,
  onCancelMove,
  onAction,
}: {
  block: ScheduleBlock;
  schedule: Schedule;
  busy: boolean;
  moving: boolean;
  onStartMove: () => void;
  onCancelMove: () => void;
  onAction: (action: BlockAction, toDate?: string) => void;
}) {
  const [toDate, setToDate] = useState(block.date);
  const done = block.status === "done";
  const label = `${block.topicName} (${block.subjectName})`;

  let note: string | null = null;
  if (done && block.doneBy === "session") note = "done in a study session";
  else if (done) note = "marked done";
  else if (block.reason === "deadline" && block.deadline) note = `before ${block.deadline.title} on ${formatDay(block.deadline.date)}`;
  else if (block.deadline) note = `for ${block.deadline.title}`;
  if (block.moved && !done) note = note ? `moved · ${note}` : "moved by you";

  return (
    <li className={done ? "calendar-block calendar-block-done" : "calendar-block"}>
      <div className="calendar-block-main">
        <span className="calendar-block-topic">{block.topicName}</span>
        <span className="calendar-block-subject">{block.subjectName}</span>
        {note && <span className="calendar-tag">{note}</span>}
      </div>
      {moving ? (
        <div className="calendar-block-move">
          <label>
            Move to
            <select value={toDate} onChange={(e) => setToDate(e.target.value)} disabled={busy} aria-label={`Move ${label} to`}>
              {schedule.days.map((d) => (
                <option key={d.date} value={d.date}>
                  {dayHeading(d.date, schedule.today)}
                  {d.available ? "" : " (day off)"}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-primary" disabled={busy || toDate === block.date} onClick={() => onAction("move", toDate)}>
            Move
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={onCancelMove}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="calendar-block-actions">
          {!done && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onAction("done")} aria-label={`Mark ${label} done`}>
              Done
            </button>
          )}
          {done && block.doneBy === "you" && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onAction("undone")} aria-label={`Mark ${label} not done`}>
              Not done
            </button>
          )}
          {!done && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={onStartMove} aria-label={`Move ${label}`}>
              Move
            </button>
          )}
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => onAction("delete")} aria-label={`Delete ${label}`}>
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

const MINUTE_CHOICES = [15, 20, 30, 45, 60, 90, 120, 180, 240];

function AvailabilityForm({
  availability,
  minutesPerBlock,
  onDirtyChange,
  onSaved,
}: {
  availability: Availability;
  minutesPerBlock: number;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (schedule: Schedule) => void;
}) {
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set(availability.weekdays));
  const [minutes, setMinutes] = useState(availability.minutesPerDay);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    minutes !== availability.minutesPerDay || [...weekdays].sort().join() !== [...availability.weekdays].sort().join();
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty]);

  const minuteChoices = MINUTE_CHOICES.includes(availability.minutesPerDay)
    ? MINUTE_CHOICES
    : [...MINUTE_CHOICES, availability.minutesPerDay].sort((a, b) => a - b);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = await saveAvailability({ weekdays: [...weekdays].sort(), minutesPerDay: minutes });
      onSaved(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your study days.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="calendar-availability"
      aria-label="Your study days"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save();
      }}
    >
      <fieldset disabled={saving}>
        <legend>Study days</legend>
        <div className="calendar-weekdays">
          {WEEKDAY_ORDER.map((d) => (
            <label key={d} title={WEEKDAY_NAMES[d]}>
              <input
                type="checkbox"
                checked={weekdays.has(d)}
                aria-label={WEEKDAY_NAMES[d]}
                onChange={() =>
                  setWeekdays((current) => {
                    const next = new Set(current);
                    if (next.has(d)) next.delete(d);
                    else next.add(d);
                    return next;
                  })
                }
              />
              {WEEKDAY_SHORT[d]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="calendar-minutes">
        About
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} disabled={saving} aria-label="Minutes per study day">
          {minuteChoices.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        minutes a day (roughly {Math.max(1, Math.floor(minutes / minutesPerBlock))} topics)
      </label>
      <div className="calendar-availability-actions">
        <button type="submit" className="btn-primary" disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save study days"}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setWeekdays(new Set(availability.weekdays));
              setMinutes(availability.minutesPerDay);
            }}
          >
            Undo changes
          </button>
        )}
      </div>
      {error && <div className="new-subject-form-error">{error}</div>}
    </form>
  );
}
