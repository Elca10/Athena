import { useEffect, useState } from "react";
import {
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

// The real dashboard (SPEC.md section 4). The top bar's "Stats" line is
// now fully wired: session stats (sessions/questions this week, streak,
// accuracy, calibration — server/src/sessionStats.js) and subscription
// usage (the account's Claude usage windows, read live via `claude -p
// "/usage"` — server/src/usageStatus.js). Subjects' and sessions' own
// Archive actions still aren't wired, and the remaining top bar action
// buttons (Report a bug, Tune Athena, Calendar) still need their own
// flows built, so they stay disabled placeholders.
const SESSION_COLUMNS: { label: string; status: SessionStatus }[] = [
  { label: "Active", status: "active" },
  { label: "Waiting", status: "waiting" },
  { label: "Completed", status: "completed" },
];

export function Dashboard() {
  const [view, setView] = useState<"dashboard" | "archive">("dashboard");
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [summaries, setSummaries] = useState<Record<string, SubjectSummary>>({});
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [usage, setUsage] = useState<UsageStatus | null>(null);

  async function refresh() {
    const list = await listSubjects();
    setSubjects(list);
    const entries = await Promise.all(list.map(async (s) => [s.id, await getSubjectSummary(s.id)] as const));
    setSummaries(Object.fromEntries(entries));
    setSessions(await listSessions());
    setStats(await getSessionStats());
    setUsage(await getUsageStatus());
  }

  useEffect(() => {
    refresh();
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

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Athena</h1>
        <div className="dashboard-stats">
          <SessionStatsSummary stats={stats} />
          <UsageStatusSummary usage={usage} />
        </div>
        <div className="dashboard-header-actions">
          <button type="button" disabled title="Coming soon">
            Report a bug
          </button>
          <button type="button" disabled title="Coming soon">
            Tune Athena
          </button>
          <button type="button" disabled title="Coming soon">
            Calendar
          </button>
          <button type="button" onClick={() => setView("archive")}>
            Archive
          </button>
        </div>
      </header>
      <div className="dashboard-body">
        <section className="dashboard-subjects">
          <h2>Subjects</h2>
          {subjects === null && <div className="dashboard-empty">Loading…</div>}
          {subjects?.length === 0 && <div className="dashboard-empty">No subjects yet.</div>}
          {subjects?.map((subject) => (
            <SubjectCard key={subject.id} subject={subject} summary={summaries[subject.id]} />
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
                  <SessionRow key={session.id} session={session} subjectName={subjectName} />
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
// restored from the Archive view." Archiving itself isn't wired up
// anywhere yet (every Archive button elsewhere is still a disabled
// placeholder), so the only action this view offers is Restore.
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
        <h1>Archive</h1>
        <div className="dashboard-header-actions">
          <button type="button" onClick={onBack}>
            Back to dashboard
          </button>
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

function SessionRow({ session, subjectName }: { session: Session; subjectName: (id: string) => string }) {
  const subjectLabel = session.subjectIds.map(subjectName).join(", ");
  const modeLabel = session.mode === "live" ? "Live" : "Ready";

  let detail: string;
  if (session.status === "active") {
    detail = "Working…";
  } else if (session.status === "waiting") {
    const prompt = session.currentQuestion?.prompt ?? "";
    detail =
      prompt.length > MAX_PROMPT_PREVIEW ? `${prompt.slice(0, MAX_PROMPT_PREVIEW)}…` : prompt || "Waiting for your answer.";
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
    </article>
  );
}

function SubjectCard({ subject, summary }: { subject: Subject; summary: SubjectSummary | undefined }) {
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
        <button type="button" disabled title="Coming soon">
          Add content
        </button>
        <button type="button" disabled title="Coming soon">
          Study
        </button>
        <button type="button" disabled title="Coming soon">
          Archive
        </button>
      </div>
    </article>
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

function UsageStatusSummary({ usage }: { usage: UsageStatus | null }) {
  return (
    <span className="dashboard-stats-usage"> · {usage ? formatUsageStatus(usage) : "Checking subscription usage…"}</span>
  );
}
