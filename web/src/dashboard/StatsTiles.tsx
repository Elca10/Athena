import type { SessionStats, UsageStatus, UsageWindow } from "./api";

// The dashboard's stats row (SPEC.md section 4): session stats
// (server/src/sessionStats.js) as a row of stat tiles, calibration as a
// small one-series column chart, and subscription usage (read live via
// `claude -p "/usage"`, server/src/usageStatus.js) as two meters. Used to
// be one long text line that was hard to scan.

function formatPercent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-label">{label}</span>
      <span className="stat-tile-value">{value}</span>
      {detail && <span className="stat-tile-detail">{detail}</span>}
    </div>
  );
}

// How often each confidence level (1–5) turned out right. Ideally the
// columns climb left to right. A level with no answers shows a dash, not
// a zero-height bar that would read as "always wrong".
function CalibrationChart({ stats }: { stats: SessionStats }) {
  const levels = stats.calibration.byConfidence;
  return (
    <div className="stat-tile stat-tile-chart">
      <span className="stat-tile-label">Calibration: % correct by confidence</span>
      <div className="calibration-chart" aria-hidden="true">
        {levels.map((b) => {
          const tip = b.total
            ? `Confidence ${b.confidence}: ${formatPercent(b.correctRate)} correct (${b.total} answered)`
            : `Confidence ${b.confidence}: nothing answered yet`;
          return (
            <div key={b.confidence} className="calibration-col" title={tip}>
              <span className="calibration-value">{b.total ? formatPercent(b.correctRate) : "—"}</span>
              <div className="calibration-track">
                {b.total > 0 && (
                  <div className="calibration-bar" style={{ height: `${Math.max(2, (b.correctRate ?? 0) * 100)}%` }} />
                )}
              </div>
              <span className="calibration-level">{b.confidence}</span>
            </div>
          );
        })}
      </div>
      <span className="calibration-axis" aria-hidden="true">
        low → high confidence
      </span>
      <table className="visually-hidden">
        <caption>Calibration: how often each confidence level was correct</caption>
        <thead>
          <tr>
            <th>Confidence</th>
            <th>Correct</th>
            <th>Answered</th>
          </tr>
        </thead>
        <tbody>
          {levels.map((b) => (
            <tr key={b.confidence}>
              <td>{b.confidence}</td>
              <td>{b.total ? formatPercent(b.correctRate) : "none yet"}</td>
              <td>{b.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SessionStatsTiles({ stats }: { stats: SessionStats | null }) {
  if (!stats) return <div className="stats-row stats-loading">Loading stats…</div>;
  const answered = stats.accuracy.total;
  return (
    <div className="stats-row">
      <Tile label="This week" value={plural(stats.sessionsThisWeek, "session")} detail={plural(stats.questionsThisWeek, "question")} />
      <Tile label="Streak" value={plural(stats.streakDays, "day")} />
      <Tile
        label="Accuracy"
        value={answered ? formatPercent(stats.accuracy.rate) : "—"}
        detail={answered ? `${stats.accuracy.correct} of ${answered} correct` : "No questions answered yet"}
      />
      {answered > 0 && <CalibrationChart stats={stats} />}
    </div>
  );
}

function formatResetsAt(resetsAt: number | undefined): string | null {
  if (!resetsAt) return null;
  return new Date(resetsAt * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const STATUS_LABEL: Record<NonNullable<UsageWindow>["status"], string> = {
  ok: "",
  warning: "Near limit",
  exceeded: "Limit reached",
};

function UsageMeter({ label, window }: { label: string; window: UsageWindow }) {
  if (!window) {
    return (
      <div className="usage-meter">
        <div className="usage-meter-head">
          <span>{label}</span>
          <span>unknown</span>
        </div>
        <div className="usage-meter-track" />
      </div>
    );
  }
  const pct = Math.round(window.utilization * 100);
  const resets = formatResetsAt(window.resetsAt);
  const state = STATUS_LABEL[window.status];
  return (
    <div className={`usage-meter usage-meter-${window.status}`}>
      <div className="usage-meter-head">
        <span>{label}</span>
        <span>
          {state && <strong>{state} · </strong>}
          {pct}% used
        </span>
      </div>
      <div className="usage-meter-track" role="meter" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="usage-meter-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {resets && <span className="usage-meter-resets">Resets {resets}</span>}
    </div>
  );
}

// "Couldn't check" alone left the user guessing. Map the usual causes to
// what to do about them; anything else shows the raw detail.
export function explainUsageError(error: string): string {
  if (/ENOENT|not found|not recognized|isn't installed|couldn't be run|no such file/i.test(error)) {
    return "Claude Code wasn't found. Install it (or restart Athena if you just installed it), then click Check now.";
  }
  if (/log ?in|logged|auth|401|credential/i.test(error)) {
    return "Claude Code isn't logged in. Open a terminal, run claude, log in, then click Check now.";
  }
  if (/timed? ?out/i.test(error)) {
    return "Claude Code took too long to answer. Try Check now again in a minute.";
  }
  if (/parse/i.test(error)) {
    return "Claude Code's usage reply has changed shape, so Athena couldn't read it. Studying still works.";
  }
  return "Claude Code reported a problem when asked for usage.";
}

export function UsageTile({
  usage,
  checking,
  onCheckNow,
}: {
  usage: UsageStatus | null;
  checking: boolean;
  onCheckNow: () => void;
}) {
  return (
    <div className="stat-tile stat-tile-usage">
      <div className="usage-tile-head">
        <span className="stat-tile-label">Claude usage</span>
        <button type="button" onClick={onCheckNow} disabled={checking}>
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>
      {!usage && <span className="stat-tile-detail">Checking subscription usage…</span>}
      {usage?.error && (
        <div className="usage-error">
          <span>Couldn't check. {explainUsageError(usage.error)}</span>
          <details>
            <summary>Details</summary>
            <code>{usage.error}</code>
          </details>
        </div>
      )}
      {usage && !usage.error && (
        <>
          <UsageMeter label="Session (5 hours)" window={usage.fiveHour} />
          <UsageMeter label="Week" window={usage.weekly} />
        </>
      )}
    </div>
  );
}
