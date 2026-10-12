import { useEffect, useRef, useState } from "react";
import {
  checkClaudeCode,
  checkGithub,
  completeSetup,
  createSubject,
  detectOs,
  getGithubConnectState,
  startGithubConnect,
  type ClaudeCodeCheck,
  type DetectedOs,
  type GithubCheck,
  type GithubConnectState,
} from "./api";

type ConfirmedOs = "windows" | "mac";

// First-run setup wizard (SPEC.md section 2; v1.0 ship scope item 3a):
// four steps — which computer this is, Claude Code, GitHub, then creating
// the first subject. Adding content for it happens on the dashboard right
// after (AddContentPanel), not in the wizard. The OS step's answer is
// lifted here and threaded into the Claude Code and GitHub steps so their
// install instructions can be OS-specific rather than generic/Mac-shaped —
// the first real friend to run this wizard is on Windows.
export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [os, setOs] = useState<ConfirmedOs | null>(null);

  return (
    <div className="setup-wizard">
      <h1>Set up Athena-Studying</h1>
      <ol className="setup-steps">
        <li className={step === 1 ? "active" : step > 1 ? "done" : ""}>Computer</li>
        <li className={step === 2 ? "active" : step > 2 ? "done" : ""}>Claude Code</li>
        <li className={step === 3 ? "active" : step > 3 ? "done" : ""}>GitHub</li>
        <li className={step === 4 ? "active" : ""}>First subject</li>
      </ol>
      {step === 1 && (
        <OsStep
          onContinue={(picked) => {
            setOs(picked);
            setStep(2);
          }}
        />
      )}
      {step === 2 && <ClaudeCodeStep os={os} onBack={() => setStep(1)} onContinue={() => setStep(3)} />}
      {step === 3 && <GithubStep os={os} onBack={() => setStep(2)} onContinue={() => setStep(4)} />}
      {step === 4 && <FirstSubjectStep onBack={() => setStep(3)} onFinish={onComplete} />}
    </div>
  );
}

// Pre-selects the server-detected OS (`process.platform`, setupChecks.js's
// `detectOs`) but always requires an explicit Continue click — a detected
// `other` (this build's own Linux dev machine; no installer script exists
// for it) leaves neither radio pre-selected, forcing a real choice between
// the two platforms this app actually supports rather than guessing wrong.
function OsStep({ onContinue }: { onContinue: (os: ConfirmedOs) => void }) {
  const [selected, setSelected] = useState<ConfirmedOs | null>(null);
  const [detecting, setDetecting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    detectOs()
      .then(({ detected }: { detected: DetectedOs }) => {
        if (!cancelled && (detected === "windows" || detected === "mac")) setSelected(detected);
      })
      .finally(() => {
        if (!cancelled) setDetecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <p>Which computer are you setting this up on?</p>
      {detecting && <p>Checking...</p>}
      {!detecting && (
        <fieldset className="setup-os-options">
          <label>
            <input type="radio" name="setup-os" checked={selected === "windows"} onChange={() => setSelected("windows")} />
            Windows
          </label>
          <label>
            <input type="radio" name="setup-os" checked={selected === "mac"} onChange={() => setSelected("mac")} />
            Mac
          </label>
        </fieldset>
      )}
      <div className="setup-actions">
        <button type="button" onClick={() => selected && onContinue(selected)} disabled={!selected || detecting}>
          Continue
        </button>
      </div>
    </section>
  );
}

function ClaudeCodeStep({ os, onBack, onContinue }: { os: ConfirmedOs | null; onBack: () => void; onContinue: () => void }) {
  const [state, setState] = useState<ClaudeCodeCheck | null>(null);
  const [checking, setChecking] = useState(false);

  async function runCheck() {
    setChecking(true);
    try {
      setState(await checkClaudeCode());
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    runCheck();
  }, []);

  // Ambiguous (`loggedIn: null`) means the check itself couldn't tell —
  // not a confirmed failure, so it doesn't block continuing.
  const canContinue = state?.installed === true && state.loggedIn !== false;

  return (
    <section>
      <p>Athena-Studying runs on your own Claude Code login — it never uses a separate API key.</p>
      {checking && <p>Checking...</p>}
      {!checking && state && !state.installed && (
        <p className="setup-error">
          Claude Code isn't installed, or couldn't be run.{" "}
          {os === "windows" ? (
            <>
              Open PowerShell and run <code>winget install --id Anthropic.ClaudeCode -e --source winget</code>, then open
              a new PowerShell window and check again.
            </>
          ) : (
            <>
              Install it from <code>claude.ai/code</code>, then check again.
            </>
          )}
        </p>
      )}
      {!checking && state?.installed && state.loggedIn === false && (
        <p className="setup-error">Claude Code is installed but not logged in. Run `claude` and log in, then check again.</p>
      )}
      {!checking && state?.installed && state.loggedIn === null && (
        <p className="setup-warning">Couldn't confirm login status ({state.detail}). You can continue if you know you're logged in.</p>
      )}
      {!checking && state?.installed && state.loggedIn === true && <p className="setup-ok">Claude Code is installed and logged in.</p>}
      <div className="setup-actions">
        <button type="button" onClick={onBack}>
          Back
        </button>
        <button type="button" onClick={runCheck} disabled={checking}>
          Check again
        </button>
        <button type="button" onClick={onContinue} disabled={!canContinue}>
          Continue
        </button>
      </div>
    </section>
  );
}

function GithubStep({ os, onBack, onContinue }: { os: ConfirmedOs | null; onBack: () => void; onContinue: () => void }) {
  const [state, setState] = useState<GithubCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [connect, setConnect] = useState<GithubConnectState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function runCheck() {
    setChecking(true);
    try {
      setState(await checkGithub());
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    runCheck();
    return () => stopPolling();
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function handleConnect() {
    const { id } = await startGithubConnect();
    stopPolling();
    await pollOnce(id);
    pollRef.current = setInterval(() => pollOnce(id), 1500);
  }

  async function pollOnce(id: string) {
    const latest = await getGithubConnectState(id);
    setConnect(latest);
    if (!latest || latest.status !== "pending") {
      stopPolling();
      if (latest?.status === "success") runCheck();
    }
  }

  const canContinue = state?.installed === true && state.authenticated === true;

  return (
    <section>
      <p>
        This needs a free GitHub.com account — only so that if you ever file a bug report, it's posted from your own
        account. Nothing else in the app uses it. Don't have one? Create it at <code>github.com/signup</code>, it only
        takes a minute.
      </p>
      {checking && <p>Checking...</p>}
      {!checking && state && !state.installed && (
        <p className="setup-error">
          The GitHub CLI (<code>gh</code>) isn't installed.{" "}
          {os === "windows" ? (
            <>
              Open PowerShell and run <code>winget install --id GitHub.cli -e --source winget</code>, then open a new
              PowerShell window and check again.
            </>
          ) : (
            <>
              Install it from <code>cli.github.com</code>, then check again.
            </>
          )}
        </p>
      )}
      {!checking && state?.installed && state.authenticated === false && !connect && (
        <button type="button" onClick={handleConnect}>
          Connect GitHub
        </button>
      )}
      {!checking && state?.installed && state.authenticated === true && <p className="setup-ok">GitHub is connected.</p>}
      {connect && connect.status === "pending" && (
        <p>
          {connect.verificationUrl && connect.code
            ? <>Open {connect.verificationUrl} and enter code <code>{connect.code}</code>.</>
            : "Starting GitHub login..."}
        </p>
      )}
      {connect?.status === "error" && <p className="setup-error">GitHub connect failed: {connect.rawOutput}</p>}
      <div className="setup-actions">
        <button type="button" onClick={onBack}>
          Back
        </button>
        <button type="button" onClick={runCheck} disabled={checking}>
          Check again
        </button>
        <button type="button" onClick={onContinue} disabled={!canContinue}>
          Continue
        </button>
      </div>
    </section>
  );
}

function FirstSubjectStep({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  async function finish(createFirst: boolean) {
    setFinishing(true);
    setError(null);
    try {
      if (createFirst) await createSubject(name.trim());
      await completeSetup();
      onFinish();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't finish setup.");
    } finally {
      setFinishing(false);
    }
  }

  return (
    <section>
      <p>Create your first subject — you can add course content for it right after, from the dashboard.</p>
      <form
        className="setup-first-subject-form"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Subject name, e.g. Organic Chemistry"
          disabled={finishing}
        />
        <button type="submit" disabled={!name.trim() || finishing}>
          Create and finish
        </button>
      </form>
      {error && <p className="setup-error">{error}</p>}
      <div className="setup-actions">
        <button type="button" onClick={onBack} disabled={finishing}>
          Back
        </button>
        <button type="button" onClick={() => finish(false)} disabled={finishing}>
          Skip for now
        </button>
      </div>
    </section>
  );
}
