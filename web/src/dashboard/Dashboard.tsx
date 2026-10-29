import { useEffect, useRef, useState } from "react";
import {
  archiveSession,
  archiveSubject,
  renameSubject,
  createSubject,
  finishSession,
  getSessionStats,
  getSubjectSummary,
  getUsageStatus,
  listSessions,
  listSubjects,
  MODE_LABELS,
  restoreSession,
  restoreSubject,
  type Session,
  type SessionStats,
  type SessionStatus,
  type Subject,
  type SubjectSummary,
  type UsageStatus,
} from "./api";
import { TuneAthenaPanel } from "./TuneAthenaPanel";
import { AddContentPanel } from "./AddContentPanel";
import { SubjectDetailPanel } from "./SubjectDetailPanel";
import { SessionStatsTiles, UsageTile } from "./StatsTiles";
import { readNewContent, type ReadStage } from "./readNewContent";
import { ReportBugPanel } from "./ReportBugPanel";
import { StudyFlow } from "./StudyFlow";
import { CalendarView } from "./CalendarView";
import { formatDay, localToday, relativeDay } from "./calendarDates";
import { UpdateControl } from "../update/UpdateControl";
import { AppearanceMenu } from "../theme/AppearanceMenu";

// The real dashboard (SPEC.md section 4). The top bar's stats row
// (StatsTiles.tsx) shows session stats and subscription usage as tiles,
// a calibration chart and usage meters. "Tune Athena" opens
// TuneAthenaPanel (SPEC.md section 8). Each subject's "Add content"
// opens AddContentPanel (SPEC.md section 7). Each subject's "Study"
// opens StudyFlow (mode picker, both Ready's and Live's session screens,
// and the shared end-of-session reflection prompt). Clicking a subject
// card's name opens SubjectDetailPanel (SPEC-v2.md section 4: topics with
// mastery, content files, past reflections) — same openPanel()-gated modal
// pattern as the others, so it can never stack with Add content/Tune/Bug
// report. A Waiting session
// row's "Resume" button opens the same StudyFlow, skipping the mode
// picker, right back into wherever that session left off (mid-question,
// mid-self-grade in Ready, or awaiting the reflection prompt). A
// subject's "Archive" and a Completed session's "Archive" both archive
// in place and refresh — SPEC.md section 4: archiving keeps the data, it
// just leaves this dashboard (and the schedule, once that exists) until
// restored from the Archive view, which already has both Restores wired.
// "Report a bug" (SPEC.md section 10/3.6) opens ReportBugPanel — describe,
// preview the redacted issue text, explicit Send. "Calendar" (SPEC-v2.md
// section 2) swaps to CalendarView, the suggested study schedule, the same
// way Archive does; each subject card shows its next deadline.
const COMPLETED_SHOWN = 5;

const SESSION_COLUMNS: { label: string; status: SessionStatus }[] = [
  { label: "Active", status: "active" },
  { label: "Waiting", status: "waiting" },
  { label: "Completed", status: "completed" },
];

export function Dashboard() {
  const [view, setView] = useState<"dashboard" | "archive" | "study" | "calendar">("dashboard");
  const [showTune, setShowTune] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showNewSubject, setShowNewSubject] = useState(false);
  const [contentSubjectId, setContentSubjectId] = useState<string | null>(null);
  const [detailSubjectId, setDetailSubjectId] = useState<string | null>(null);
  const [studySubjectId, setStudySubjectId] = useState<string | null>(null);
  const [resumeSession, setResumeSession] = useState<Session | null>(null);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  // Archived ones too, only so a session of an archived subject can still
  // be labelled by name instead of "Unknown subject".
  const [allSubjects, setAllSubjects] = useState<Subject[]>([]);
  const [summaries, setSummaries] = useState<Record<string, SubjectSummary>>({});
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [usageChecking, setUsageChecking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const usageCheckInFlight = useRef(false);
  // Subjects whose new content is being read in the background (after
  // Add content's Done), and which stage each is on.
  const [reading, setReading] = useState<Record<string, ReadStage>>({});
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const readingNow = useRef(new Set<string>());
  const readAgain = useRef(new Set<string>());

  // Bug queue #3: `/usage` is free (no inference), but nothing was ever
  // re-checking it after the initial load, so a tab left open through a
  // usage window's reset (or through Live-mode turns) showed a stale
  // percentage forever. `usageCheckInFlight` guards every caller below
  // (the poll, the visibility trigger, the manual button, and `refresh`'s
  // own call) against overlapping `/usage` calls piling up behind its
  // up-to-45s timeout.
  async function refreshUsage() {
    if (usageCheckInFlight.current) return;
    usageCheckInFlight.current = true;
    setUsageChecking(true);
    try {
      setUsage(await getUsageStatus());
    } finally {
      usageCheckInFlight.current = false;
      setUsageChecking(false);
    }
  }

  // A failed load (e.g. Athena restarting) used to leave "Loading…" on
  // screen forever; now it says so and offers a retry.
  async function refresh() {
    try {
      const everything = await listSubjects({ includeArchived: true });
      const list = everything.filter((s) => !s.archived);
      setAllSubjects(everything);
      setSubjects(list);
      const entries = await Promise.all(list.map(async (s) => [s.id, await getSubjectSummary(s.id)] as const));
      setSummaries(Object.fromEntries(entries));
      setSessions(await listSessions());
      setStats(await getSessionStats());
      setLoadError(null);
    } catch {
      setLoadError("Couldn't load your dashboard. Athena may be restarting. Wait a moment, then try again.");
      return;
    }
    await refreshUsage().catch(() => {});
  }

  useEffect(() => {
    refresh();
  }, []);

  // Periodic + manual usage refresh (bug queue #3). Polls every few
  // minutes while the tab is visible, and checks again immediately when
  // the tab becomes visible after being hidden, so switching back to
  // Athena always shows a current reading rather than waiting out the
  // rest of the interval.
  useEffect(() => {
    const USAGE_POLL_MS = 5 * 60 * 1000;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refreshUsage();
    }, USAGE_POLL_MS);
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refreshUsage();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Issue #17: leaving a Live session while its question was being written
  // listed it under Active as "Working…" forever, because the list was
  // only fetched on load. While anything is Active, re-check every few
  // seconds; once its turn ends it moves to Waiting with a Resume button.
  const anyActive = sessions?.some((s) => s.status === "active") ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const ACTIVE_POLL_MS = 3000;
    const interval = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        setSessions(await listSessions());
      } catch {
        // Athena restarting: the next tick tries again.
      }
    }, ACTIVE_POLL_MS);
    return () => clearInterval(interval);
  }, [anyActive]);

  // Done in Add content closes the panel straight away and lands here.
  // If that subject is already being read (Done again after adding more),
  // the server would skip an overlapping scan, so run one more pass once
  // the current one finishes instead of dropping the new content.
  async function startReading(subjectId: string) {
    if (readingNow.current.has(subjectId)) {
      readAgain.current.add(subjectId);
      return;
    }
    readingNow.current.add(subjectId);
    const messages: string[] = [];
    let allOk = true;
    try {
      do {
        readAgain.current.delete(subjectId);
        const outcome = await readNewContent(subjectId, subjectName(subjectId), (stage) =>
          setReading((r) => ({ ...r, [subjectId]: stage })),
        );
        if (outcome.message) messages.push(outcome.message);
        allOk &&= outcome.ok;
        refresh();
      } while (readAgain.current.has(subjectId));
    } finally {
      readingNow.current.delete(subjectId);
      setReading((r) => {
        const next = { ...r };
        delete next[subjectId];
        return next;
      });
    }
    if (messages.length) setNotice({ text: messages.join(" "), ok: allOk });
  }

  const subjectName = (id: string) => {
    const subject = allSubjects.find((s) => s.id === id);
    if (!subject) return "Unknown subject";
    return subject.archived ? `${subject.name} (archived)` : subject.name;
  };

  // Only one panel at a time: opening one closes any other, so they can
  // never stack on top of each other.
  function openPanel(panel: "bug" | "tune" | "content" | "detail", subjectId?: string) {
    setShowBugReport(panel === "bug");
    setShowTune(panel === "tune");
    setContentSubjectId(panel === "content" ? subjectId ?? null : null);
    setDetailSubjectId(panel === "detail" ? subjectId ?? null : null);
  }

  const noticeBanner = notice && (
    <div className={notice.ok ? "dashboard-notice" : "dashboard-notice dashboard-notice-error"} role={notice.ok ? "status" : "alert"}>
      <span>{notice.text}</span>
      <button type="button" onClick={() => setNotice(null)}>
        Dismiss
      </button>
    </div>
  );
  const readingIds = Object.keys(reading);

  if (view === "archive") {
    return (
      <ArchiveView
        onBack={() => {
          setView("dashboard");
          refresh();
        }}
      />
    );
  }

  if (view === "calendar") {
    return (
      <CalendarView
        onBack={() => {
          setView("dashboard");
          refresh();
        }}
      />
    );
  }

  if (view === "study" && (studySubjectId || resumeSession)) {
    return (
      <StudyFlow
        subjects={subjects ?? []}
        initialSubjectId={studySubjectId ?? undefined}
        resumeSession={resumeSession}
        readingSubjectIds={readingIds}
        banner={
          <>
            {readingIds.map((id) => (
              <div key={id} className="dashboard-notice dashboard-notice-progress" role="status">
                <span>
                  {reading[id] === "topics"
                    ? `Still reading your new content for ${subjectName(id)}…`
                    : `Writing practice questions for ${subjectName(id)}…`}{" "}
                  New topics will be in your next session once this finishes.
                </span>
              </div>
            ))}
            {noticeBanner}
          </>
        }
        onExit={() => {
          setView("dashboard");
          setStudySubjectId(null);
          setResumeSession(null);
          refresh();
        }}
      />
    );
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-header-top">
          <h1>Athena</h1>
          <div className="dashboard-header-actions">
            <UpdateControl onReportBug={() => openPanel("bug")} />
            <AppearanceMenu />
            <button type="button" onClick={() => openPanel("bug")}>
              Report a bug
            </button>
            <button type="button" onClick={() => openPanel("tune")}>
              Tune Athena
            </button>
            <button type="button" onClick={() => setView("calendar")}>
              Calendar
            </button>
            <button type="button" onClick={() => setView("archive")}>
              Archive
            </button>
          </div>
        </div>
        <div className="dashboard-stats">
          <SessionStatsTiles stats={stats} />
          <UsageTile usage={usage} checking={usageChecking} onCheckNow={refreshUsage} />
        </div>
      </header>
      {loadError && (
        <div className="dashboard-load-error" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {noticeBanner}
      {showBugReport && <ReportBugPanel onClose={() => setShowBugReport(false)} />}
      {showTune && <TuneAthenaPanel onClose={() => setShowTune(false)} />}
      {contentSubjectId && (
        <AddContentPanel
          subjectId={contentSubjectId}
          subjectName={subjectName(contentSubjectId)}
          onClose={() => setContentSubjectId(null)}
          onContentAdded={refresh}
          onDone={() => startReading(contentSubjectId)}
        />
      )}
      {detailSubjectId && (
        <SubjectDetailPanel
          subjectId={detailSubjectId}
          subjectName={subjectName(detailSubjectId)}
          onClose={() => setDetailSubjectId(null)}
          onContentChanged={refresh}
        />
      )}
      <div className="dashboard-body">
        <section className="dashboard-subjects">
          <div className="dashboard-subjects-header">
            <h2>Subjects</h2>
            <button type="button" className="btn-primary" onClick={() => setShowNewSubject(true)}>
              New subject
            </button>
          </div>
          {showNewSubject && (
            <NewSubjectForm
              onClose={() => setShowNewSubject(false)}
              onCreated={async () => {
                setShowNewSubject(false);
                await refresh();
              }}
            />
          )}
          {subjects === null && <div className="dashboard-empty">Loading…</div>}
          {subjects?.length === 0 && !showNewSubject && (
            <div className="dashboard-empty">No subjects yet — click "New subject" above to add your first one.</div>
          )}
          <div className="subject-grid">
          {subjects?.map((subject) => (
            <SubjectCard
              key={subject.id}
              subject={subject}
              summary={summaries[subject.id]}
              readingStage={reading[subject.id]}
              onOpenDetail={() => openPanel("detail", subject.id)}
              onAddContent={() => openPanel("content", subject.id)}
              onStudy={() => {
                setStudySubjectId(subject.id);
                setView("study");
              }}
              onRenamed={refresh}
              onArchive={async () => {
                if (!window.confirm(`Archive "${subject.name}"? It leaves the dashboard; you can restore it from the Archive.`)) return;
                await archiveSubject(subject.id);
                refresh();
              }}
            />
          ))}
          </div>
        </section>
        <section className="dashboard-sessions">
          {SESSION_COLUMNS.map(({ label, status }) => {
            let columnSessions = sessions?.filter((s) => s.status === status) ?? [];
            // Completed piles up: newest first, and only the latest few
            // unless asked.
            const collapsible = status === "completed" && columnSessions.length > COMPLETED_SHOWN;
            const total = columnSessions.length;
            if (status === "completed") {
              columnSessions = [...columnSessions].sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
              if (collapsible && !showAllCompleted) columnSessions = columnSessions.slice(0, COMPLETED_SHOWN);
            }
            return (
              <div className="dashboard-session-column" key={status}>
                <h2>{label}</h2>
                {sessions === null && <div className="dashboard-empty">Loading…</div>}
                {sessions !== null && columnSessions.length === 0 && (
                  <div className="dashboard-empty">Nothing here yet.</div>
                )}
                {columnSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    subjectName={subjectName}
                    onResume={
                      session.status === "waiting"
                        ? () => {
                            setResumeSession(session);
                            setView("study");
                          }
                        : undefined
                    }
                    onEnd={
                      session.status === "waiting" && !session.reflectionPending
                        ? async () => {
                            if (!window.confirm("End this session? Anything not answered yet won't count.")) return;
                            const result = await finishSession(session.id).catch(() => null);
                            if (result?.reflection) {
                              setResumeSession(result.session);
                              setView("study");
                            } else {
                              refresh();
                            }
                          }
                        : undefined
                    }
                    onArchive={
                      session.status === "completed"
                        ? async () => {
                            await archiveSession(session.id);
                            refresh();
                          }
                        : undefined
                    }
                  />
                ))}
                {collapsible && (
                  <button type="button" className="session-show-all" onClick={() => setShowAllCompleted((v) => !v)}>
                    {showAllCompleted ? "Show fewer" : `Show all ${total}`}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}

// SPEC.md section 4: "Sessions and subjects can both be archived and
// restored from the Archive view." Archiving itself happens from the main
// dashboard (a subject's own Archive button; a Completed session's) — the
// only action this dedicated view offers is the other half, Restore.
function ArchiveView({ onBack }: { onBack: () => void }) {
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);

  async function refresh() {
    // Fetches every subject/session, not just the archived ones, so a
    // session's subject name can still be resolved even when that
    // subject itself isn't archived.
    setSubjects(await listSubjects({ includeArchived: true }));
    setSessions(await listSessions({ includeArchived: true }));
  }

  useEffect(() => {
    refresh();
  }, []);

  const subjectName = (id: string) => subjects?.find((s) => s.id === id)?.name ?? "Unknown subject";
  const archivedSubjects = subjects?.filter((s) => s.archived) ?? [];
  const archivedSessions = sessions?.filter((s) => s.archived) ?? [];

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-header-top">
          <h1>Archive</h1>
          <div className="dashboard-header-actions">
            <AppearanceMenu />
            <button type="button" onClick={onBack}>
              Back to dashboard
            </button>
          </div>
        </div>
      </header>
      <div className="dashboard-body">
        <section className="dashboard-subjects">
          <h2>Archived subjects</h2>
          {subjects === null && <div className="dashboard-empty">Loading…</div>}
          {subjects !== null && archivedSubjects.length === 0 && (
            <div className="dashboard-empty">No archived subjects.</div>
          )}
          <div className="subject-grid">
          {archivedSubjects.map((subject) => (
            <article className="subject-card" key={subject.id}>
              <h3>{subject.name}</h3>
              <div className="subject-card-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={async () => {
                    await restoreSubject(subject.id);
                    refresh();
                  }}
                >
                  Restore
                </button>
              </div>
            </article>
          ))}
          </div>
        </section>
        <section className="dashboard-sessions">
          <h2>Archived sessions</h2>
          {sessions === null && <div className="dashboard-empty">Loading…</div>}
          {sessions !== null && archivedSessions.length === 0 && (
            <div className="dashboard-empty">No archived sessions.</div>
          )}
          {archivedSessions.map((session) => (
            <article className="session-row" key={session.id}>
              <div className="session-row-header">
                <span className="session-row-subjects">{session.subjectIds.map(subjectName).join(", ")}</span>
                <span className="session-row-mode">{MODE_LABELS[session.mode] ?? session.mode}</span>
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={async () => {
                  await restoreSession(session.id);
                  refresh();
                }}
              >
                Restore
              </button>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}

const MAX_PROMPT_PREVIEW = 80;

function SessionRow({
  session,
  subjectName,
  onResume,
  onEnd,
  onArchive,
}: {
  session: Session;
  subjectName: (id: string) => string;
  onResume?: () => void;
  onEnd?: () => void;
  onArchive?: () => void;
}) {
  const subjectLabel = session.subjectIds.map(subjectName).join(", ");
  const modeLabel = MODE_LABELS[session.mode] ?? session.mode;

  let detail: string;
  if (session.status === "active") {
    detail = "Working…";
  } else if (session.status === "waiting") {
    if (session.reflectionPending) {
      detail = "Waiting on your end-of-session reflection.";
    } else {
      const prompt = session.currentQuestion?.prompt ?? "";
      detail =
        prompt.length > MAX_PROMPT_PREVIEW
          ? `${prompt.slice(0, MAX_PROMPT_PREVIEW)}…`
          : prompt || "Paused — resume to pick up where you left off.";
    }
  } else {
    const answered = `${session.history.length} question${session.history.length === 1 ? "" : "s"} answered`;
    const ended = session.endedAt
      ? new Date(session.endedAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : null;
    detail = ended ? `${ended} · ${answered}` : answered;
  }

  return (
    <article className="session-row">
      <div className="session-row-header">
        <span className="session-row-subjects">{subjectLabel}</span>
        <span className="session-row-mode">{modeLabel}</span>
      </div>
      <div className="session-row-detail">{detail}</div>
      {(onResume || onEnd) && (
        <div className="session-row-actions">
          {onResume && (
            <button type="button" className="btn-primary" onClick={onResume}>
              Resume
            </button>
          )}
          {/* Ending from here never starts a model turn, unlike Resume. */}
          {onEnd && (
            <button type="button" onClick={onEnd}>
              End
            </button>
          )}
        </div>
      )}
      {onArchive && (
        <button type="button" onClick={onArchive}>
          Archive
        </button>
      )}
    </article>
  );
}

function SubjectCard({
  subject,
  summary,
  readingStage,
  onOpenDetail,
  onAddContent,
  onStudy,
  onRenamed,
  onArchive,
}: {
  subject: Subject;
  summary: SubjectSummary | undefined;
  readingStage?: ReadStage;
  onOpenDetail: () => void;
  onAddContent: () => void;
  onStudy: () => void;
  onRenamed: () => void;
  onArchive: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  return (
    <article className="subject-card">
      {renaming ? (
        <RenameSubjectForm
          subject={subject}
          onClose={() => setRenaming(false)}
          onRenamed={() => {
            setRenaming(false);
            onRenamed();
          }}
        />
      ) : (
        <button type="button" className="subject-card-title" onClick={onOpenDetail}>
          <h3>{subject.name}</h3>
        </button>
      )}
      {summary ? (
        <div className="subject-card-stats">
          <span>
            {summary.masteryCounts.new} new · {summary.masteryCounts.learning} learning ·{" "}
            {summary.masteryCounts.mastered} mastered
          </span>
          <span>{summary.dueCount} due today</span>
          <span>{summary.bankSize} ready questions</span>
          {summary.nextDeadline && (
            <span className="subject-card-deadline">
              Next deadline: {summary.nextDeadline.title}, {formatDay(summary.nextDeadline.date)} (
              {relativeDay(summary.nextDeadline.date, localToday())})
            </span>
          )}
          {readingStage ? (
            <span className="subject-card-hint" role="status">
              {readingStage === "topics"
                ? "Reading your new content for topics… This can take a minute or two; you can keep using Athena."
                : "Writing practice questions for the new topics… Almost there."}
            </span>
          ) : (
            <NextStepHint summary={summary} />
          )}
        </div>
      ) : (
        <div className="subject-card-stats">Loading stats…</div>
      )}
      <div className="subject-card-actions">
        <button type="button" className="btn-secondary" onClick={onAddContent}>
          Add content
        </button>
        <button type="button" className="btn-primary" onClick={onStudy}>
          Study
        </button>
        <button type="button" className="btn-secondary" onClick={() => setRenaming(true)} disabled={renaming}>
          Rename
        </button>
        <button type="button" className="btn-secondary" onClick={onArchive}>
          Archive
        </button>
      </div>
    </article>
  );
}

// Issue #6: same rules as creating a subject (length cap, no duplicate
// names); the server's reason is shown as-is when it refuses.
function RenameSubjectForm({ subject, onClose, onRenamed }: { subject: Subject; onClose: () => void; onRenamed: () => void }) {
  const [name, setName] = useState(subject.name);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmed = name.trim().replace(/\s+/g, " ");

  async function submit() {
    if (!trimmed) return;
    if (trimmed === subject.name) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await renameSubject(subject.id, trimmed);
      onRenamed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rename that subject.");
      setSubmitting(false);
    }
  }

  return (
    <form
      className="new-subject-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !submitting) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <input
        type="text"
        aria-label={`New name for ${subject.name}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
        autoFocus
        onFocus={(e) => e.target.select()}
        disabled={submitting}
      />
      <button type="submit" className="btn-primary" disabled={!trimmed || submitting}>
        Save
      </button>
      <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
        Cancel
      </button>
      {error && <div className="new-subject-form-error">{error}</div>}
    </form>
  );
}

// What to do next with this subject, when it isn't obvious: a brand-new
// subject has nothing to study until content is added, and content added
// but closed without Done hasn't been read for topics yet.
function NextStepHint({ summary }: { summary: SubjectSummary }) {
  let hint: string | null = null;
  if (summary.unreadContentCount > 0) {
    const n = summary.unreadContentCount;
    hint = `${n} item${n === 1 ? "" : "s"} not read yet. Open Add content and click Done.`;
  } else if (summary.contentCount === 0 && summary.topicCount === 0) {
    hint = "Next: add your course content (slides, PDFs or notes).";
  }
  return hint ? <span className="subject-card-hint">{hint}</span> : null;
}

function NewSubjectForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await createSubject(trimmed);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create that subject.");
      setSubmitting(false);
    }
  }

  return (
    <form
      className="new-subject-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Subject name, e.g. Organic Chemistry"
        maxLength={100}
        autoFocus
        disabled={submitting}
      />
      <button type="submit" className="btn-primary" disabled={!name.trim() || submitting}>
        Create
      </button>
      <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
        Cancel
      </button>
      {error && <div className="new-subject-form-error">{error}</div>}
    </form>
  );
}
