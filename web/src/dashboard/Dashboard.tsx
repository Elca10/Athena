import { useEffect, useState } from "react";
import {
  getSubjectSummary,
  listSessions,
  listSubjects,
  restoreSession,
  restoreSubject,
  type Session,
  type SessionStatus,
  type Subject,
  type SubjectSummary,
} from "./api";

// The real dashboard (SPEC.md section 4). This step adds the Archive view
// (subjects' and sessions' own Archive actions still aren't wired — only
// restoring an already-archived item is possible so far) alongside the
// session data wired in the previous step — the remaining top bar actions
// and every subject/session card's own action buttons still need their
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

  async function refresh() {
    const list = await listSubjects();
    setSubjects(list);
    const entries = await Promise.all(list.map(async (s) => [s.id, await getSubjectSummary(s.id)] as const));
    setSummaries(Object.fromEntries(entries));
    setSessions(await listSessions());
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
        <div className="dashboard-stats">Usage and session stats — coming soon.</div>
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
