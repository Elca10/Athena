import { useEffect, useRef, useState } from "react";
import {
  archiveSession,
  archiveSubject,
  createSubject,
  getSessionStats,
  getSubjectSummary,
  getUsageStatus,
  listSessions,
  listSubjects,
  restoreSession,
  restoreSubject,
  type Session,
  type SessionStats,
  type SessionStatus,
  type Subject,
  type SubjectSummary,
  type UsageStatus,
  type UsageWindow,
} from "./api";
import { TuneAthenaPanel } from "./TuneAthenaPanel";
import { AddContentPanel } from "./AddContentPanel";
import { ReportBugPanel } from "./ReportBugPanel";
import { StudyFlow } from "./StudyFlow";
import { UpdateControl } from "../update/UpdateControl";
import { ThemeToggle } from "../theme/ThemeToggle";

// The real dashboard (SPEC.md section 4). The top bar's "Stats" line is
// fully wired: session stats (sessions/questions this week, streak,
// accuracy, calibration — server/src/sessionStats.js) and subscription
// usage (the account's Claude usage windows, read live via `claude -p
// "/usage"` — server/src/usageStatus.js). "Tune Athena" opens
// TuneAthenaPanel (SPEC.md section 8). Each subject's "Add content"
// opens AddContentPanel (SPEC.md section 7). Each subject's "Study"
// opens StudyFlow (mode picker, both Ready's and Live's session screens,
// and the shared end-of-session reflection prompt). A Waiting session
// row's "Resume" button opens the same StudyFlow, skipping the mode
// picker, right back into wherever that session left off (mid-question,
// mid-self-grade in Ready, or awaiting the reflection prompt). A
// subject's "Archive" and a Completed session's "Archive" both archive
// in place and refresh — SPEC.md section 4: archiving keeps the data, it
// just leaves this dashboard (and the schedule, once that exists) until
// restored from the Archive view, which already has both Restores wired.
// "Report a bug" (SPEC.md section 10/3.6) opens ReportBugPanel — describe,
// preview the redacted issue text, explicit Send. "Calendar" (SPEC.md
// section 14: still v2) stays hidden entirely rather than shown disabled
// — v1.0 ship scope has no "Coming soon" stub visible anywhere in the UI.
const SESSION_COLUMNS: { label: string; status: SessionStatus }[] = [
  { label: "Active", status: "active" },
  { label: "Waiting", status: "waiting" },
  { label: "Completed", status: "completed" },
];

export function Dashboard() {
  const [view, setView] = useState<"dashboard" | "archive" | "study">("dashboard");
  const [showTune, setShowTune] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showNewSubject, setShowNewSubject] = useState(false);
  const [contentSubjectId, setContentSubjectId] = useState<string | null>(null);
  const [studySubjectId, setStudySubjectId] = useState<string | null>(null);
  const [resumeSession, setResumeSession] = useState<Session | null>(null);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [summaries, setSummaries] = useState<Record<string, SubjectSummary>>({});
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [usageChecking, setUsageChecking] = useState(false);
  const usageCheckInFlight = useRef(false);

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

  async function refresh() {
    const list = await listSubjects();
    setSubjects(list);
    const entries = await Promise.all(list.map(async (s) => [s.id, await getSubjectSummary(s.id)] as const));
    setSummaries(Object.fromEntries(entries));
    setSessions(await listSessions());
    setStats(await getSessionStats());
    await refreshUsage();
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

  const subjectName = (id: string) => subjects?.find((s) => s.id === id)?.name ?? "Unknown subject";

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

  if (view === "study" && (studySubjectId || resumeSession)) {
    return (
      <StudyFlow
        subjects={subjects ?? []}
        initialSubjectId={studySubjectId ?? undefined}
        resumeSession={resumeSession}
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
            <UpdateControl onReportBug={() => setShowBugReport(true)} />
            <ThemeToggle />
            <button type="button" onClick={() => setShowBugReport((v) => !v)}>
              Report a bug
            </button>
            <button type="button" onClick={() => setShowTune((v) => !v)}>
              Tune Athena
            </button>
            <button type="button" onClick={() => setView("archive")}>
              Archive
            </button>
          </div>
        </div>
        <div className="dashboard-stats">
          <SessionStatsSummary stats={stats} />
          <UsageStatusSummary usage={usage} checking={usageChecking} onCheckNow={refreshUsage} />
        </div>
      </header>
      {showBugReport && <ReportBugPanel onClose={() => setShowBugReport(false)} />}
      {showTune && <TuneAthenaPanel onClose={() => setShowTune(false)} />}
      {contentSubjectId && (
        <AddContentPanel
          subjectId={contentSubjectId}
          subjectName={subjectName(contentSubjectId)}
          onClose={() => setContentSubjectId(null)}
          onContentAdded={refresh}
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
          {subjects?.map((subject) => (
            <SubjectCard
              key={subject.id}
              subject={subject}
              summary={summaries[subject.id]}
              onAddContent={() => setContentSubjectId(subject.id)}
              onStudy={() => {
                setStudySubjectId(subject.id);
                setView("study");
              }}
              onArchive={async () => {
                await archiveSubject(subject.id);
                refresh();
              }}
            />
          ))}
        </section>
        <section className="dashboard-sessions">
          {SESSION_COLUMNS.map(({ label, status }) => {
            const columnSessions = sessions?.filter((s) => s.status === status) ?? [];
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
            <ThemeToggle />
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
                <span className="session-row-mode">{session.mode === "live" ? "Live" : "Ready"}</span>
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
  onArchive,
}: {
  session: Session;
  subjectName: (id: string) => string;
  onResume?: () => void;
  onArchive?: () => void;
}) {
  const subjectLabel = session.subjectIds.map(subjectName).join(", ");
  const modeLabel = session.mode === "live" ? "Live" : "Ready";

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
          : prompt || "Waiting for your answer.";
    }
  } else {
    detail = `${session.history.length} question${session.history.length === 1 ? "" : "s"} answered`;
  }

  return (
    <article className="session-row">
      <div className="session-row-header">
        <span className="session-row-subjects">{subjectLabel}</span>
        <span className="session-row-mode">{modeLabel}</span>
      </div>
      <div className="session-row-detail">{detail}</div>
      {onResume && (
        <button type="button" className="btn-primary" onClick={onResume}>
          Resume
        </button>
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
  onAddContent,
  onStudy,
  onArchive,
}: {
  subject: Subject;
  summary: SubjectSummary | undefined;
  onAddContent: () => void;
  onStudy: () => void;
  onArchive: () => void;
}) {
  return (
    <article className="subject-card">
      <h3>{subject.name}</h3>
      {summary ? (
        <div className="subject-card-stats">
          <span>
            {summary.masteryCounts.new} new · {summary.masteryCounts.learning} learning ·{" "}
            {summary.masteryCounts.mastered} mastered
          </span>
          <span>{summary.dueCount} due today</span>
          <span>{summary.bankSize} ready questions</span>
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
        <button type="button" className="btn-secondary" onClick={onArchive}>
          Archive
        </button>
      </div>
    </article>
  );
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

function formatPercent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

// SPEC.md section 6's Calibration principle: "dashboard shows predicted vs
// actual accuracy over time". Rendered as one segment per confidence level
// that has at least one answered question — confidence IS the prediction,
// so there's no separate "predicted" number to show per level, just how
// often that confidence level turned out right. Empty when nothing has
// been answered yet, same as accuracy going unshown below.
function formatCalibration(stats: SessionStats): string {
  const levelsWithData = stats.calibration.byConfidence.filter((b) => b.total > 0);
  if (levelsWithData.length === 0) return "";
  const segments = levelsWithData.map((b) => `confidence ${b.confidence} → ${formatPercent(b.correctRate)} (${b.total})`);
  return ` · Calibration: ${segments.join(", ")}`;
}

// Built as one plain string, not nested elements, so the rendered stats
// line is a single text node — easier to assert on in tests and avoids any
// ambiguity between a parent and child both matching the same text query.
function formatSessionStats(stats: SessionStats): string {
  const sessionsLabel = `${stats.sessionsThisWeek} session${stats.sessionsThisWeek === 1 ? "" : "s"}`;
  const questionsLabel = `${stats.questionsThisWeek} question${stats.questionsThisWeek === 1 ? "" : "s"} this week`;
  const streakLabel = `${stats.streakDays}-day streak`;
  const accuracyLabel =
    stats.accuracy.total === 0
      ? "no questions answered yet"
      : `${formatPercent(stats.accuracy.rate)} accuracy (${stats.accuracy.correct}/${stats.accuracy.total})`;
  const calibrationLabel = stats.accuracy.total > 0 ? formatCalibration(stats) : "";
  return `${sessionsLabel} · ${questionsLabel} · ${streakLabel} · ${accuracyLabel}${calibrationLabel}`;
}

function SessionStatsSummary({ stats }: { stats: SessionStats | null }) {
  return <span className="dashboard-stats-sessions">{stats ? formatSessionStats(stats) : "Loading stats…"}</span>;
}

function formatResetsAt(resetsAt: number | undefined): string {
  if (!resetsAt) return "";
  const when = new Date(resetsAt * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return ` (resets ${when})`;
}

function formatUsageWindow(label: string, window: UsageWindow): string {
  if (!window) return `${label}: unknown`;
  return `${label}: ${Math.round(window.utilization * 100)}% used${formatResetsAt(window.resetsAt)}`;
}

// SPEC.md section 4's "subscription usage" stat, read live off the `claude`
// CLI's own `/usage` command (server/src/usageStatus.js) rather than
// derived from anything this app tracks itself. A non-null `error` means
// the check itself failed (CLI missing/not logged in, or a future CLI
// reply shape this app's parser doesn't recognize yet) — shown plainly
// rather than silently falling back to stale or invented numbers.
function formatUsageStatus(usage: UsageStatus): string {
  if (usage.error) return "Subscription usage — couldn't check.";
  return `Subscription usage — ${formatUsageWindow("session", usage.fiveHour)} · ${formatUsageWindow("week", usage.weekly)}`;
}

function UsageStatusSummary({
  usage,
  checking,
  onCheckNow,
}: {
  usage: UsageStatus | null;
  checking: boolean;
  onCheckNow: () => void;
}) {
  return (
    <span className="dashboard-stats-usage">
      {" "}
      · {usage ? formatUsageStatus(usage) : "Checking subscription usage…"}{" "}
      <button type="button" onClick={onCheckNow} disabled={checking}>
        {checking ? "Checking…" : "Check now"}
      </button>
    </span>
  );
}
