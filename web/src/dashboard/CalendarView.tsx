import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  getSchedule,
  listSubjects,
  listTopics,
  moveScheduleBlocks,
  type Subject,
  type Topic,
  saveAvailability,
  scheduleBlockAction,
  type Availability,
  type BlockAction,
  type Schedule,
  type ScheduleBlock,
} from "./api";
import { dayHeading, formatDay, WEEKDAY_NAMES, WEEKDAY_ORDER, WEEKDAY_SHORT } from "./calendarDates";
import { AppearanceMenu } from "../theme/AppearanceMenu";
import { CanvasImport } from "./CanvasImport";
import { CalendarSubscribe } from "./CalendarSubscribe";
import { DeadlinesSection } from "./DeadlinesSection";
import { CalendarWeek, groupBySubject } from "./CalendarWeek";

// Issue #23: List or Week, remembered on this device.
const VIEW_STORAGE_KEY = "athena.calendarView";
type CalendarLayout = "list" | "week";

function storedLayout(): CalendarLayout {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "week" ? "week" : "list";
  } catch {
    return "list";
  }
}

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
  const [deadlineDirty, setDeadlineDirty] = useState(false);
  // Issue #22: planned blocks picked for a batch move, and where to.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchTo, setBatchTo] = useState("");
  const [layout, setLayout] = useState<CalendarLayout>(storedLayout);
  const [scrollTo, setScrollTo] = useState<string | null>(null);

  function chooseLayout(next: CalendarLayout) {
    setLayout(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Private mode etc.: the choice just isn't remembered.
    }
  }

  // "Open day" in the week view: switch to the list, then bring that day
  // into view once it has rendered.
  useEffect(() => {
    if (!scrollTo || layout !== "list") return;
    const el = document.getElementById(`calendar-day-${scrollTo}`);
    setScrollTo(null);
    if (!el) return;
    // The page header is sticky: land the day just below it, not under it.
    const header = document.querySelector(".dashboard-header")?.getBoundingClientRect().height ?? 0;
    window.scrollTo?.({ top: el.getBoundingClientRect().top + window.scrollY - header - 8 });
  }, [scrollTo, layout]);

  // A fresh schedule can drop blocks (done in a session, the day passed):
  // keep only picks that are still planned.
  useEffect(() => {
    if (!schedule) return;
    const planned = new Set(schedule.days.flatMap((d) => d.blocks).filter((b) => b.status === "planned").map((b) => b.id));
    setSelected((current) => {
      const kept = [...current].filter((id) => planned.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [schedule]);

  function toggleSelected(ids: string[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function moveSelected() {
    if (!batchTo || selected.size === 0) return;
    const count = selected.size;
    setBusy(true);
    setMessage(null);
    try {
      const result = await moveScheduleBlocks([...selected], batchTo);
      if (result.schedule) setSchedule(result.schedule);
      if (!result.ok) {
        setMessage({ text: result.error, ok: false });
      } else {
        setSelected(new Set());
        setMessage({ text: `Moved ${count} topic${count === 1 ? "" : "s"} to ${formatDay(batchTo)}.`, ok: true });
      }
    } catch {
      setMessage({ text: "Couldn't reach Athena. Check it's still running, then try again.", ok: false });
    } finally {
      setBusy(false);
    }
  }

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
    if (deadlineDirty && !window.confirm("Leave without saving this deadline?")) return;
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

          <CalendarDeadlines onChanged={load} onDirtyChange={setDeadlineDirty} />

          <CanvasImport onImported={load} />

          <CalendarSubscribe />

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
              deadline above.
            </div>
          )}

          <div className="calendar-layout-toggle" role="group" aria-label="Calendar layout">
            <button type="button" aria-pressed={layout === "list"} onClick={() => chooseLayout("list")}>
              List
            </button>
            <button type="button" aria-pressed={layout === "week"} onClick={() => chooseLayout("week")}>
              Week
            </button>
          </div>

          {layout === "week" && (
            <CalendarWeek
              schedule={schedule}
              onOpenDay={(date) => {
                chooseLayout("list");
                setScrollTo(date);
              }}
            />
          )}

          {layout === "list" && (
            <ol className="calendar-days">
              {schedule.days.map((day) => {
                const minutes = day.blocks.filter((b) => b.status === "planned").length * schedule.minutesPerBlock;
                return (
                  <li key={day.date} id={`calendar-day-${day.date}`} className={day.available ? "calendar-day" : "calendar-day calendar-day-off"}>
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
                        {groupBySubject(day.blocks).map((group) => {
                          const row = (block: ScheduleBlock) => (
                            <BlockRow
                              key={block.id}
                              block={block}
                              schedule={schedule}
                              busy={busy}
                              moving={movingId === block.id}
                              selected={selected.has(block.id)}
                              onToggleSelected={(on) => toggleSelected([block.id], on)}
                              onStartMove={() => setMovingId(block.id)}
                              onCancelMove={() => setMovingId(null)}
                              onAction={(action, toDate) => act(block, action, toDate)}
                            />
                          );
                          if (group.blocks.length === 1) return row(group.blocks[0]);
                          return (
                            <SubjectGroup
                              key={`${day.date}:${group.subjectId}`}
                              subjectName={group.subjectName}
                              blocks={group.blocks}
                              selected={selected}
                              busy={busy}
                              onToggleSelected={toggleSelected}
                            >
                              {group.blocks.map(row)}
                            </SubjectGroup>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          {layout === "list" && selected.size > 0 && (
            <div className="calendar-batch-bar" role="region" aria-label="Move selected topics">
              <span>
                {selected.size} topic{selected.size === 1 ? "" : "s"} selected
              </span>
              <label>
                Move to
                <select value={batchTo} onChange={(e) => setBatchTo(e.target.value)} disabled={busy} aria-label="Move selected topics to">
                  <option value="">Pick a day…</option>
                  {schedule.days.map((d) => (
                    <option key={d.date} value={d.date}>
                      {dayHeading(d.date, schedule.today)}
                      {d.available ? "" : " (day off)"}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn-primary" disabled={busy || !batchTo} onClick={moveSelected}>
                Move
              </button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Issue #22: a day's topics for one subject, collapsed to one row until
// opened. Its checkbox picks every planned topic in it for a batch move.
function SubjectGroup({
  subjectName,
  blocks,
  selected,
  busy,
  onToggleSelected,
  children,
}: {
  subjectName: string;
  blocks: ScheduleBlock[];
  selected: Set<string>;
  busy: boolean;
  onToggleSelected: (ids: string[], on: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const plannedIds = blocks.filter((b) => b.status === "planned").map((b) => b.id);
  const pickedCount = plannedIds.filter((id) => selected.has(id)).length;
  const done = blocks.length - plannedIds.length;
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = pickedCount > 0 && pickedCount < plannedIds.length;
  }, [pickedCount, plannedIds.length]);

  return (
    <li className="calendar-group">
      <div className="calendar-group-header">
        {plannedIds.length > 0 && (
          <input
            ref={checkbox}
            type="checkbox"
            checked={pickedCount === plannedIds.length}
            disabled={busy}
            aria-label={`Select all ${subjectName} topics`}
            onChange={(e) => onToggleSelected(plannedIds, e.target.checked)}
          />
        )}
        <button type="button" className="calendar-group-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> <span className="calendar-block-topic">{subjectName}</span>
          <span className="calendar-block-subject">
            {blocks.length} topics{done ? ` · ${done} done` : ""}
          </span>
        </button>
      </div>
      {open && <ul className="calendar-blocks calendar-group-blocks">{children}</ul>}
    </li>
  );
}

// Issue #21: deadlines can be added here, not only from a subject's detail
// view, for courses that don't put their dates on Canvas. Same list and
// form as the detail view, one subject at a time.
function CalendarDeadlines({ onChanged, onDirtyChange }: { onChanged: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const active = (await listSubjects()).filter((s) => !s.archived);
        setSubjects(active);
        setSubjectId((current) => current ?? active[0]?.id ?? null);
      } catch {
        // No subjects to offer: the panel stays hidden, the rest of the
        // Calendar still works.
        setSubjects([]);
      }
    })();
  }, []);

  useEffect(() => {
    if (!subjectId) return;
    let cancelled = false;
    setTopics(null);
    (async () => {
      let list: Topic[] = [];
      try {
        list = await listTopics(subjectId);
      } catch {
        // The form still works: it just can't offer "only some topics".
      }
      if (!cancelled) setTopics(Array.isArray(list) ? list : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [subjectId]);

  function reportDirty(next: boolean) {
    setDirty(next);
    onDirtyChange(next);
  }

  if (subjects === null || subjects.length === 0 || !subjectId) return null;

  const picker = (
    <label className="calendar-deadlines-subject">
      for
      <select
        value={subjectId}
        aria-label="Subject for deadlines"
        onChange={(e) => {
          if (dirty && !window.confirm("Discard this deadline? What you typed won't be saved.")) return;
          reportDirty(false);
          setSubjectId(e.target.value);
        }}
      >
        {subjects.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="calendar-deadlines">
      <DeadlinesSection key={subjectId} subjectId={subjectId} topics={topics} onChanged={onChanged} onDirtyChange={reportDirty} headerExtra={picker} />
    </div>
  );
}

function BlockRow({
  block,
  schedule,
  busy,
  moving,
  selected,
  onToggleSelected,
  onStartMove,
  onCancelMove,
  onAction,
}: {
  block: ScheduleBlock;
  schedule: Schedule;
  busy: boolean;
  moving: boolean;
  selected: boolean;
  onToggleSelected: (on: boolean) => void;
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
        {!done && (
          <input
            type="checkbox"
            checked={selected}
            disabled={busy}
            aria-label={`Select ${label}`}
            onChange={(e) => onToggleSelected(e.target.checked)}
          />
        )}
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
