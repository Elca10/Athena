import { useEffect, useState } from "react";
import { getSubjectSummary, listSubjects, type Subject, type SubjectSummary } from "./api";

// The real dashboard (SPEC.md section 4). This step wires in real subject
// data (name + mastery/due/bank-size stats) for the left column — the top
// bar actions, session columns, and the subject cards' own action buttons
// (Add content/Study/Archive) all still need their flows built, so they
// stay disabled placeholders.
const SESSION_COLUMNS = ["Active", "Waiting", "Completed"] as const;

export function Dashboard() {
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [summaries, setSummaries] = useState<Record<string, SubjectSummary>>({});

  useEffect(() => {
    listSubjects().then(async (list) => {
      setSubjects(list);
      const entries = await Promise.all(list.map(async (s) => [s.id, await getSubjectSummary(s.id)] as const));
      setSummaries(Object.fromEntries(entries));
    });
  }, []);

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
          {SESSION_COLUMNS.map((label) => (
            <div className="dashboard-session-column" key={label}>
              <h2>{label}</h2>
              <div className="dashboard-empty">Nothing here yet.</div>
            </div>
          ))}
        </section>
      </div>
    </div>
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
