import { useEffect, useState } from "react";
import {
  connectCanvasFeed,
  disconnectCanvasFeed,
  getCanvasFeedStatus,
  importCanvasFeedEvents,
  listCanvasFeedEvents,
  listSubjects,
  updateDeadline,
  type CanvasFeedEvent,
  type CanvasFeedStatus,
  type Subject,
} from "./api";
import { formatDay } from "./calendarDates";

// Import deadlines from the user's Canvas calendar feed (SPEC-v2.md
// section 2, server/src/canvasFeed.js). Collapsed by default and loaded
// only when opened, so the Calendar itself never waits on Canvas. Every
// step has a way forward: connect, tick events and pick their subjects,
// add them; events already added show up as such, and one whose date or
// title changed in Canvas gets an Update button (never applied on its own).

const UNREACHABLE = "Couldn't reach Athena. Check it's still running, then try again.";

export function CanvasImport({ onImported }: { onImported: () => void }) {
  const [opened, setOpened] = useState(false);
  const [status, setStatus] = useState<CanvasFeedStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  async function loadStatus() {
    setStatusError(null);
    try {
      setStatus(await getCanvasFeedStatus());
    } catch {
      setStatusError(UNREACHABLE);
    }
  }

  return (
    <details
      className="canvas-import"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !opened) {
          setOpened(true);
          loadStatus();
        }
      }}
    >
      <summary>Import deadlines from Canvas</summary>
      <div className="canvas-import-body">
        {statusError && (
          <div className="dashboard-notice dashboard-notice-error" role="alert">
            <span>{statusError}</span>
            <button type="button" onClick={loadStatus}>
              Try again
            </button>
          </div>
        )}
        {!statusError && status === null && <p className="canvas-import-hint">Loading…</p>}
        {status && !status.connected && <ConnectForm onConnected={setStatus} />}
        {status?.connected && (
          <FeedEvents
            host={status.host ?? "Canvas"}
            onDisconnected={() => setStatus({ connected: false, host: null })}
            onImported={onImported}
          />
        )}
      </div>
    </details>
  );
}

function ConnectForm({ onConnected }: { onConnected: (status: CanvasFeedStatus) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      onConnected(await connectCanvasFeed(url.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="canvas-connect"
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim() && !busy) connect();
      }}
    >
      <p className="canvas-import-hint">
        In Canvas, open <strong>Calendar</strong>, click <strong>Calendar Feed</strong> at the bottom right, and copy the
        link. Paste it here once. The link is private, so Athena keeps it on this computer only and never puts it in a
        bug report.
      </p>
      <label className="canvas-connect-field">
        Calendar feed link
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…/feeds/calendars/user_….ics"
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="canvas-import-actions">
        <button type="submit" className="btn-primary" disabled={!url.trim() || busy}>
          {busy ? "Checking the link…" : "Connect"}
        </button>
      </div>
      {error && (
        <div className="new-subject-form-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

function FeedEvents({ host, onDisconnected, onImported }: { host: string; onDisconnected: () => void; onImported: () => void }) {
  const [events, setEvents] = useState<CanvasFeedEvent[] | null>(null);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [subjectFor, setSubjectFor] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  async function load() {
    setError(null);
    setEvents(null);
    try {
      const [nextEvents, nextSubjects] = await Promise.all([listCanvasFeedEvents(), listSubjects()]);
      setSubjects(nextSubjects);
      setEvents(nextEvents);
      setSubjectFor((current) => {
        const next = { ...current };
        for (const e of nextEvents) if (!(e.uid in next) && e.suggestedSubjectId) next[e.uid] = e.suggestedSubjectId;
        return next;
      });
      setTicked((current) => new Set([...current].filter((uid) => nextEvents.some((e) => e.uid === uid && !e.imported))));
    } catch (err) {
      setError(err instanceof Error ? err.message : UNREACHABLE);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function disconnect() {
    if (!window.confirm("Disconnect your Canvas calendar? Deadlines you already added stay.")) return;
    setBusy(true);
    try {
      await disconnectCanvasFeed();
      onDisconnected();
    } catch {
      setNotice({ text: UNREACHABLE, ok: false });
      setBusy(false);
    }
  }

  const fresh = events?.filter((e) => !e.imported) ?? [];
  const added = events?.filter((e) => e.imported) ?? [];
  const tickedEvents = fresh.filter((e) => ticked.has(e.uid));
  const missingSubject = tickedEvents.some((e) => !subjectFor[e.uid]);
  const subjectName = (id: string) => subjects?.find((s) => s.id === id)?.name ?? "a removed subject";

  async function addTicked() {
    setBusy(true);
    setNotice(null);
    const bySubject = new Map<string, string[]>();
    for (const e of tickedEvents) bySubject.set(subjectFor[e.uid], [...(bySubject.get(subjectFor[e.uid]) ?? []), e.uid]);
    let count = 0;
    try {
      for (const [subjectId, uids] of bySubject) count += (await importCanvasFeedEvents(subjectId, uids)).added.length;
      setTicked(new Set());
      setNotice({ text: `Added ${count} deadline${count === 1 ? "" : "s"}. The plan below now paces for ${count === 1 ? "it" : "them"}.`, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : UNREACHABLE;
      setNotice({ text: count ? `Added ${count}, then stopped: ${msg}` : msg, ok: false });
    } finally {
      setBusy(false);
      if (count) onImported();
      load();
    }
  }

  async function applyCanvasChange(e: CanvasFeedEvent) {
    if (!e.imported) return;
    setBusy(true);
    setNotice(null);
    try {
      await updateDeadline(e.imported.subjectId, e.imported.deadlineId, { title: e.title, date: e.date });
      setNotice({ text: `Updated ${e.title} to match Canvas.`, ok: true });
      onImported();
      await load();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : UNREACHABLE, ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="canvas-events">
      <div className="canvas-events-header">
        <span>
          Connected to <strong>{host}</strong>
        </span>
        <div className="canvas-import-actions">
          <button type="button" className="btn-secondary" disabled={busy || events === null} onClick={load}>
            Refresh
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </div>

      {notice && (
        <div className={notice.ok ? "dashboard-notice" : "dashboard-notice dashboard-notice-error"} role={notice.ok ? "status" : "alert"}>
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="dashboard-notice dashboard-notice-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {!error && events === null && <p className="canvas-import-hint">Loading your Canvas events…</p>}

      {events && subjects && (
        <>
          {fresh.length === 0 && added.length === 0 && <p className="canvas-import-hint">No upcoming events in your Canvas calendar.</p>}
          {subjects.length === 0 && fresh.length > 0 && (
            <p className="canvas-import-hint">Create a subject on the dashboard first, then come back to add these to it.</p>
          )}
          {fresh.length > 0 && subjects.length > 0 && (
            <>
              <p className="canvas-import-hint">Tick the ones to study for and pick their subject.</p>
              <ul className="canvas-event-list">
                {fresh.map((e) => (
                  <li key={e.uid} className="canvas-event">
                    <label className="canvas-event-pick">
                      <input
                        type="checkbox"
                        checked={ticked.has(e.uid)}
                        disabled={busy}
                        onChange={() =>
                          setTicked((current) => {
                            const next = new Set(current);
                            if (next.has(e.uid)) next.delete(e.uid);
                            else next.add(e.uid);
                            return next;
                          })
                        }
                      />
                      <span className="canvas-event-title">{e.title}</span>
                      <span className="canvas-event-meta">
                        {formatDay(e.date)}
                        {e.course ? ` · ${e.course}` : ""}
                      </span>
                    </label>
                    <select
                      aria-label={`Subject for ${e.title}`}
                      value={subjectFor[e.uid] ?? ""}
                      disabled={busy}
                      onChange={(ev) => {
                        const value = ev.target.value;
                        setSubjectFor((current) => ({ ...current, [e.uid]: value }));
                        if (value) setTicked((current) => new Set(current).add(e.uid));
                      }}
                    >
                      <option value="">Pick a subject…</option>
                      {subjects.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
              <div className="canvas-import-actions">
                <button type="button" className="btn-primary" disabled={busy || tickedEvents.length === 0 || missingSubject} onClick={addTicked}>
                  {busy ? "Adding…" : tickedEvents.length ? `Add ${tickedEvents.length} to deadlines` : "Add to deadlines"}
                </button>
                {missingSubject && <span className="canvas-import-hint">Pick a subject for each ticked event.</span>}
              </div>
            </>
          )}
          {added.length > 0 && (
            <>
              <h3 className="canvas-events-subheading">Already added</h3>
              <ul className="canvas-event-list">
                {added.map((e) => (
                  <li key={e.uid} className="canvas-event canvas-event-added">
                    <div className="canvas-event-pick">
                      <span className="canvas-event-title">{e.imported!.title}</span>
                      <span className="canvas-event-meta">
                        {formatDay(e.imported!.date)} · {subjectName(e.imported!.subjectId)}
                      </span>
                      {e.changed && (
                        <span className="canvas-event-changed">
                          Canvas now says {e.title !== e.imported!.title ? `“${e.title}”` : ""}
                          {e.title !== e.imported!.title && e.date !== e.imported!.date ? ", " : ""}
                          {e.date !== e.imported!.date ? formatDay(e.date) : ""}
                        </span>
                      )}
                    </div>
                    {e.changed && (
                      <button type="button" className="btn-secondary" disabled={busy} onClick={() => applyCanvasChange(e)} aria-label={`Update ${e.imported!.title} to match Canvas`}>
                        Update
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
