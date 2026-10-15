import { useEffect, useRef, useState } from "react";
import { applyUpdate, getHealth, getUpdateStatus, type UpdateStatus } from "./api";
import { useEscapeKey } from "../useEscapeKey";
import { useFocusTrap } from "../useFocusTrap";

// One-click updates, the UI half (server: routes/update.js, updateApply.js;
// installers/updater.mjs does the actual update). Renders nothing unless
// an update is available. Then: a small pill in the top bar → a confirm
// dialog → an "Updating…" overlay that polls /api/health until the NEW
// commit answers and then reloads the page. If the server comes back on
// the old version instead (rolled back / failed / cancelled), it says so
// in plain words rather than reloading.

const STATUS_POLL_MS = 5 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

type Phase =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "updating"; to: string; startedAt: number }
  | { kind: "message"; title: string; text: string; offerBugReport: boolean };

// A dialog section that takes keyboard focus while it's shown.
function DialogSection(props: React.ComponentPropsWithoutRef<"section">) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref);
  return <section ref={ref} tabIndex={-1} {...props} />;
}

export function UpdateControl({
  onReportBug,
  pollMs = 2000,
  reload = () => window.location.reload(),
}: {
  onReportBug: () => void;
  pollMs?: number;
  reload?: () => void;
}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [startError, setStartError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEscapeKey(() => setPhase({ kind: "idle" }), phase.kind === "confirm" || phase.kind === "message");

  async function refreshStatus() {
    try {
      const next = await getUpdateStatus();
      if (mounted.current) setStatus(next);
    } catch {
      // Not worth a banner: no status just means no pill.
    }
  }

  useEffect(() => {
    mounted.current = true;
    refreshStatus();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refreshStatus();
    }, STATUS_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(interval);
    };
  }, []);

  // While updating: wait for the new commit to answer, or for the server
  // to report how the attempt ended.
  useEffect(() => {
    if (phase.kind !== "updating") return;
    const { to, startedAt } = phase;
    let stopped = false;
    async function poll() {
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (stopped) return;
        try {
          const health = await getHealth();
          if (health.commit === to) {
            reload();
            return;
          }
          const latest = await getUpdateStatus();
          const last = latest.lastUpdate;
          if (last && Date.parse(last.finishedAt) >= startedAt && last.result !== "updated") {
            setStatus(latest);
            setPhase(
              last.result === "cancelled"
                ? {
                    kind: "message",
                    title: "Update cancelled",
                    text: "Athena was busy, so it didn't update. Nothing changed. Try again in a minute.",
                    offerBugReport: false,
                  }
                : {
                    kind: "message",
                    title: "Update didn't work",
                    text: "You're still on the previous version, and everything you've done is saved. Want to report a bug so it can be fixed?",
                    offerBugReport: true,
                  },
            );
            return;
          }
        } catch {
          // Server down mid-restart: keep waiting.
        }
        if (Date.now() - startedAt > UPDATE_TIMEOUT_MS) {
          setPhase({
            kind: "message",
            title: "Still restarting",
            text: "Athena is taking longer than expected to come back. Wait a minute, then reopen it the usual way (the Athena-Studying shortcut on Windows, the install command on a Mac).",
            offerBugReport: false,
          });
          return;
        }
      }
    }
    poll();
    return () => {
      stopped = true;
    };
  }, [phase, pollMs, reload]);

  async function confirmUpdate() {
    setStartError(null);
    const result = await applyUpdate();
    if (!result.ok) {
      setStartError(result.reason);
      return;
    }
    setPhase({ kind: "updating", to: result.to, startedAt: Date.now() });
  }

  const blockedReason = status?.blockedReason ?? null;

  return (
    <>
      {status?.available && phase.kind === "idle" && (
        <div className="update-pill" role="status">
          <span>Update available</span>
          <button
            type="button"
            className="btn-primary"
            disabled={!!blockedReason}
            title={blockedReason ?? undefined}
            onClick={() => {
              setStartError(null);
              setPhase({ kind: "confirm" });
              refreshStatus();
            }}
          >
            Update now
          </button>
          {blockedReason && (
            <span className="update-reason" title={blockedReason}>
              Available when Athena finishes
            </span>
          )}
        </div>
      )}

      {phase.kind === "confirm" && (
        <div className="modal-backdrop">
          <DialogSection className="modal update-modal" role="dialog" aria-modal="true" aria-labelledby="update-confirm-title">
            <h2 id="update-confirm-title">Update Athena?</h2>
            <p>Athena will restart for about a minute; your work is saved.</p>
            {blockedReason && <p className="update-error">{blockedReason}</p>}
            {startError && <p className="update-error">{startError}</p>}
            <div className="update-modal-actions">
              <button type="button" onClick={() => setPhase({ kind: "idle" })}>
                Cancel
              </button>
              <button type="button" className="btn-primary" disabled={!!blockedReason} onClick={confirmUpdate}>
                Update now
              </button>
            </div>
          </DialogSection>
        </div>
      )}

      {phase.kind === "updating" && (
        <div className="modal-backdrop update-overlay">
          <DialogSection className="modal update-modal" role="dialog" aria-modal="true" aria-labelledby="update-progress-title" aria-busy="true">
            <h2 id="update-progress-title">Updating…</h2>
            <p>Athena is restarting with the new version. This page will reload by itself when it's ready.</p>
          </DialogSection>
        </div>
      )}

      {phase.kind === "message" && (
        <div className="modal-backdrop">
          <DialogSection className="modal update-modal" role="dialog" aria-modal="true" aria-labelledby="update-message-title">
            <h2 id="update-message-title">{phase.title}</h2>
            <p>{phase.text}</p>
            <div className="update-modal-actions">
              <button type="button" onClick={() => setPhase({ kind: "idle" })}>
                Close
              </button>
              {phase.offerBugReport && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    setPhase({ kind: "idle" });
                    onReportBug();
                  }}
                >
                  Report a bug
                </button>
              )}
            </div>
          </DialogSection>
        </div>
      )}
    </>
  );
}
