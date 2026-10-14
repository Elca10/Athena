import { useState } from "react";
import { previewBugReport, sendBugReport, type BugReportPreview } from "./api";
import { useEscapeKey } from "../useEscapeKey";

// "Report a bug" (SPEC.md section 10/3.6 — the plain-report-and-file
// half only; no Bug Fixer in v1.0). Three steps, matching the backend's
// own preview-then-send split so nothing is ever filed without the user
// seeing the EXACT text first:
//   1. "describe" — a plain-language description field.
//   2. "preview" — the server's redacted {title, body}, shown read-only,
//      with an explicit warning that the repo and the user's GitHub
//      username are both public. Nothing has happened yet at this point.
//   3. "result" — after an explicit "Send", either the filed issue's URL
//      or a plain-language error (gh not installed/logged in, offline).
type Step = "describe" | "preview" | "sending" | "result";

export function ReportBugPanel({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("describe");
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState<BugReportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: true; url: string } | { ok: false; error: string } | null>(null);
  // Not while sending: closing then would hide whether it was filed.
  useEscapeKey(onClose, step !== "sending");

  async function goToPreview() {
    setError(null);
    try {
      setPreview(await previewBugReport(description));
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't build a preview.");
    }
  }

  async function send() {
    if (!preview) return;
    setStep("sending");
    try {
      setResult(await sendBugReport(preview));
    } catch {
      // Without this, a dropped connection left the panel on "Sending…" forever.
      setResult({ ok: false, error: "Couldn't reach Athena to send the report. Check that it's still running, then try again." });
    }
    setStep("result");
  }

  return (
    <div className="modal-backdrop">
      <section className="bug-report-panel modal" role="dialog" aria-modal="true" aria-labelledby="bug-report-title">
        <div className="bug-report-panel-header">
          <h2 id="bug-report-title">Report a bug</h2>
          <button type="button" onClick={onClose} disabled={step === "sending"}>
            Close
          </button>
        </div>

        {step === "describe" && (
          <form
            className="bug-report-describe"
            onSubmit={(e) => {
              e.preventDefault();
              goToPreview();
            }}
          >
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What went wrong? Be as specific as you can — what you were doing, what you expected, what happened instead…"
              rows={5}
              autoFocus
            />
            <p className="bug-report-note">
              Athena will add some technical details automatically (app version, your OS, recent error messages) and show you
              exactly what will be posted before anything is sent.
            </p>
            {error && <div className="bug-report-error">{error}</div>}
            <button type="submit" className="btn-primary" disabled={!description.trim()}>
              Preview report
            </button>
          </form>
        )}

        {step === "preview" && preview && (
          <div className="bug-report-preview">
            <p className="bug-report-warning">
              This will be posted as a <strong>public</strong> GitHub issue on Athena-Studying's repository — anyone can see
              it, including your GitHub username. Technical details were redacted automatically, but review the text below
              before sending.
            </p>
            <div className="bug-report-preview-field">
              <label>Title</label>
              <div className="bug-report-preview-text">{preview.title}</div>
            </div>
            <div className="bug-report-preview-field">
              <label>Body</label>
              <pre className="bug-report-preview-text bug-report-preview-body">{preview.body}</pre>
            </div>
            <div className="bug-report-preview-actions">
              <button type="button" onClick={() => setStep("describe")}>
                Back
              </button>
              <button type="button" className="btn-primary" onClick={send}>
                Send
              </button>
            </div>
          </div>
        )}

        {step === "sending" && <div className="dashboard-empty">Sending…</div>}

        {step === "result" && result && (
          <div className="bug-report-result">
            {result.ok ? (
              <p>
                Reported — thank you.{" "}
                <a href={result.url} target="_blank" rel="noreferrer">
                  View the issue
                </a>
                .
              </p>
            ) : (
              <p className="bug-report-error">{result.error}</p>
            )}
            <button type="button" className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
