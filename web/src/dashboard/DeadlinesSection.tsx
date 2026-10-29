import { useEffect, useState, type ReactNode } from "react";
import { createDeadline, deleteDeadline, listDeadlines, updateDeadline, type Deadline, type Topic } from "./api";
import { formatDay, localToday, relativeDay } from "./calendarDates";

// The subject detail view's Deadlines section (SPEC.md section 9,
// SPEC-v2.md section 2): add, edit and delete hand-entered deadlines, and
// choose which ones to study for (the Calendar paces their topics so
// they're reviewed before the date). Its own component so the detail panel
// only needs one line for it.
//
// A half-filled add/edit form is never thrown away silently: the panel
// asks before closing while `onDirtyChange(true)` is in effect.
export function DeadlinesSection({
  subjectId,
  topics,
  onChanged,
  onDirtyChange,
  headerExtra,
}: {
  subjectId: string;
  /** Shown beside the heading, e.g. the Calendar's subject picker. */
  headerExtra?: ReactNode;
  /** The subject's topics, or null while the panel is still loading them. */
  topics: Topic[] | null;
  /** After any saved change, so the subject card's next deadline updates. */
  onChanged?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [deadlines, setDeadlines] = useState<Deadline[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Deadline | "new" | null>(null);
  const today = localToday();

  async function refresh() {
    setLoadError(null);
    try {
      const list = await listDeadlines(subjectId);
      if (!Array.isArray(list)) throw new Error("unexpected response");
      setDeadlines(list);
    } catch {
      setLoadError("Couldn't load deadlines.");
    }
  }

  useEffect(() => {
    refresh();
  }, [subjectId]);

  useEffect(() => {
    if (!editing) onDirtyChange?.(false);
  }, [editing]);

  async function toggleStudying(deadline: Deadline) {
    setActionError(null);
    setBusyId(deadline.id);
    try {
      await updateDeadline(subjectId, deadline.id, { studying: !deadline.studying });
      await refresh();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't save that change.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(deadline: Deadline) {
    if (
      !window.confirm(
        `Delete the deadline "${deadline.title}"? Its topics stop being paced for it. Study blocks you've moved or marked done stay on your calendar.`,
      )
    ) {
      return;
    }
    setActionError(null);
    setBusyId(deadline.id);
    try {
      await deleteDeadline(subjectId, deadline.id);
      await refresh();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't delete that deadline.");
    } finally {
      setBusyId(null);
    }
  }

  const topicName = (id: string) => topics?.find((t) => t.id === id)?.name;

  function coverage(deadline: Deadline): string {
    if (!deadline.topicIds.length) return "Covers all topics";
    if (topics === null) return `Covers ${deadline.topicIds.length} topic${deadline.topicIds.length === 1 ? "" : "s"}`;
    const names = deadline.topicIds.map(topicName).filter((n): n is string => !!n);
    if (!names.length) return "Its topics were removed. Edit it to pick others.";
    const shown = names.slice(0, 3).join(", ");
    return `Covers ${shown}${names.length > 3 ? ` +${names.length - 3} more` : ""}`;
  }

  return (
    <section className="subject-detail-section" aria-labelledby="subject-detail-deadlines">
      <div className="subject-detail-section-header">
        <h3 id="subject-detail-deadlines">Deadlines</h3>
        {headerExtra}
        {!editing && deadlines !== null && (
          <button type="button" className="btn-secondary" onClick={() => setEditing("new")}>
            Add deadline
          </button>
        )}
      </div>
      {loadError && (
        <div className="content-panel-error">
          {loadError}{" "}
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {actionError && <div className="content-panel-error">{actionError}</div>}
      {!loadError && deadlines === null && <div className="dashboard-empty">Loading…</div>}
      {editing && (
        <DeadlineForm
          key={editing === "new" ? "new" : editing.id}
          subjectId={subjectId}
          topics={topics}
          deadline={editing === "new" ? null : editing}
          today={today}
          onDirtyChange={onDirtyChange}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
            onChanged?.();
          }}
        />
      )}
      {!loadError && deadlines !== null && deadlines.length === 0 && !editing && (
        <div className="dashboard-empty">
          No deadlines yet. Add your exams and due dates, and the Calendar will make sure their topics are reviewed in time.
        </div>
      )}
      {!loadError && deadlines !== null && deadlines.length > 0 && (
        <ul className="deadline-list">
          {deadlines.map((deadline) => {
            const past = deadline.date < today;
            return (
              <li key={deadline.id} className={past ? "deadline-item deadline-past" : "deadline-item"}>
                <div className="deadline-main">
                  <strong>{deadline.title}</strong>
                  <span className="deadline-date">
                    {formatDay(deadline.date)} · {past ? "passed" : relativeDay(deadline.date, today)}
                  </span>
                  <span className="deadline-coverage">{coverage(deadline)}</span>
                </div>
                <div className="deadline-actions">
                  <label className="deadline-studying">
                    <input
                      type="checkbox"
                      checked={deadline.studying}
                      disabled={busyId === deadline.id || past}
                      onChange={() => toggleStudying(deadline)}
                    />
                    Study for this
                  </label>
                  <button type="button" className="btn-secondary" disabled={busyId === deadline.id || !!editing} onClick={() => setEditing(deadline)}>
                    Edit
                  </button>
                  <button type="button" className="btn-secondary" disabled={busyId === deadline.id} onClick={() => remove(deadline)}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DeadlineForm({
  subjectId,
  topics,
  deadline,
  today,
  onDirtyChange,
  onCancel,
  onSaved,
}: {
  subjectId: string;
  topics: Topic[] | null;
  deadline: Deadline | null;
  today: string;
  onDirtyChange?: (dirty: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const existingIds = new Set((topics ?? []).map((t) => t.id));
  const initialPicked = (deadline?.topicIds ?? []).filter((id) => topics === null || existingIds.has(id));
  const initialScope: "all" | "some" = deadline && deadline.topicIds.length > 0 ? "some" : "all";
  const [title, setTitle] = useState(deadline?.title ?? "");
  const [date, setDate] = useState(deadline?.date ?? "");
  const [scope, setScope] = useState<"all" | "some">(initialScope);
  const [picked, setPicked] = useState<Set<string>>(new Set(initialPicked));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty =
    title !== (deadline?.title ?? "") ||
    date !== (deadline?.date ?? "") ||
    scope !== initialScope ||
    (scope === "some" && [...picked].sort().join() !== [...initialPicked].sort().join());

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty]);

  const needsTopic = scope === "some" && picked.size === 0;
  const canSave = !!title.trim() && !!date && !needsTopic && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const input = { title: title.trim(), date, topicIds: scope === "all" ? [] : [...picked] };
    try {
      if (deadline) await updateDeadline(subjectId, deadline.id, input);
      else await createDeadline(subjectId, input);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that deadline.");
      setSaving(false);
    }
  }

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <form
      className="deadline-form"
      aria-label={deadline ? `Edit ${deadline.title}` : "New deadline"}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        // Escape cancels this form only after asking, and never closes the
        // whole panel underneath it.
        if (e.key === "Escape") {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          if (!saving && (!dirty || window.confirm("Discard this deadline? What you typed won't be saved."))) onCancel();
        }
      }}
    >
      <label>
        Title
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Midterm exam"
          maxLength={120}
          autoFocus
          disabled={saving}
        />
      </label>
      <label>
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={saving} />
      </label>
      {date && date < today && <div className="deadline-form-hint">That date has already passed. Athena won't plan any study for it.</div>}
      <fieldset className="deadline-form-scope" disabled={saving}>
        <legend>Which topics does it cover?</legend>
        <label>
          <input type="radio" name="deadline-scope" checked={scope === "all"} onChange={() => setScope("all")} />
          All of this subject's topics
        </label>
        <label>
          <input
            type="radio"
            name="deadline-scope"
            checked={scope === "some"}
            onChange={() => setScope("some")}
            disabled={!topics || topics.length === 0}
          />
          Only some topics
        </label>
        {topics !== null && topics.length === 0 && (
          <div className="deadline-form-hint">No topics yet. It will cover the topics Athena finds once you add content.</div>
        )}
        {scope === "some" && topics && topics.length > 0 && (
          <div className="deadline-topic-picker">
            {topics.map((topic) => (
              <label key={topic.id}>
                <input type="checkbox" checked={picked.has(topic.id)} onChange={() => toggle(topic.id)} />
                {topic.name}
              </label>
            ))}
          </div>
        )}
        {needsTopic && <div className="deadline-form-hint">Pick at least one topic, or choose all topics.</div>}
      </fieldset>
      {error && <div className="new-subject-form-error">{error}</div>}
      <div className="deadline-form-actions">
        <button type="submit" className="btn-primary" disabled={!canSave}>
          {saving ? "Saving…" : deadline ? "Save changes" : "Add deadline"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={saving}
          onClick={() => {
            if (!dirty || window.confirm("Discard this deadline? What you typed won't be saved.")) onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
