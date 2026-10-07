// The real dashboard (SPEC.md section 4). This step scaffolds the shell/
// layout only — top bar actions and the subjects/sessions columns are all
// static placeholders for now; wiring real subjects, sessions, and stats
// data in is a separate, later step.
const SESSION_COLUMNS = ["Active", "Waiting", "Completed"] as const;

export function Dashboard() {
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
          <div className="dashboard-empty">No subjects yet.</div>
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
