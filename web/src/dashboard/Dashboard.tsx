import { useEffect, useState } from "react";
import {
  getSubjectSummary,
  listSessions,
  listSubjects,
  type Session,
  type SessionStatus,
  type Subject,
  type SubjectSummary,
} from "./api";

// The real dashboard (SPEC.md section 4). This step wires in real session
// data (grouped into the Active/Waiting/Completed columns) alongside the
// subject data wired in the previous step — the top bar actions and every
// subject/session card's own action buttons still need their flows built,
// so they stay disabled placeholders.
const SESSION_COLUMNS: { label: string; status: SessionStatus }[] = [
  { label: "Active", status: "active" },
  { label: "Waiting", status: "waiting" },
  { label: "Completed", status: "completed" },
];

export function Dashboard() {
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [summaries, setSummaries] = useState<Record<string, SubjectSummary>>({});
  const [sessions, setSessions] = useState<Session[] | null>(null);

  useEffect(() => {
    listSubjects().then(async (list) => {
      setSubjects(list);
      const entries = await Promise.all(list.map(async (s) => [s.id, await getSubjectSummary(s.id)] as const));
      setSummaries(Object.fromEntries(entries));
    });
    listSessions().then(setSessions);
  }, []);

  const subjectName = (id: string) => subjects?.find((s) => s.id === id)?.name ?? "Unknown subject";

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
          <button type="button" disabled title="Coming soon">
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
