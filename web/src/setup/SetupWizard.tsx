import { useEffect, useRef, useState } from "react";
import {
  checkClaudeCode,
  checkGithub,
  completeSetup,
  getGithubConnectState,
  startGithubConnect,
  type ClaudeCodeCheck,
  type GithubCheck,
  type GithubConnectState,
} from "./api";

// First-run setup wizard (SPEC.md section 2): three steps — Claude Code,
// GitHub, then handing off to subject creation (a stub for now; real
// subject creation lands in build step 2, see routes/setup.js's own note).
export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  return (
    <div className="setup-wizard">
      <h1>Set up Athena-Studying</h1>
      <ol className="setup-steps">
        <li className={step === 1 ? "active" : step > 1 ? "done" : ""}>Claude Code</li>
        <li className={step === 2 ? "active" : step > 2 ? "done" : ""}>GitHub</li>
        <li className={step === 3 ? "active" : ""}>First subject</li>
      </ol>
      {step === 1 && <ClaudeCodeStep onContinue={() => setStep(2)} />}
      {step === 2 && <GithubStep onBack={() => setStep(1)} onContinue={() => setStep(3)} />}
      {step === 3 && <FirstSubjectStep onBack={() => setStep(2)} onFinish={onComplete} />}
    </div>
  );
}

function ClaudeCodeStep({ onContinue }: { onContinue: () => void }) {
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
          Claude Code isn't installed, or couldn't be run. Install it from{" "}
          <code>claude.ai/code</code>, then check again.
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

function GithubStep({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
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
      <p>Bug reports (section 10) are filed as GitHub issues using your own GitHub account.</p>
      {checking && <p>Checking...</p>}
      {!checking && state && !state.installed && (
        <p className="setup-error">
          The GitHub CLI (<code>gh</code>) isn't installed. Install it from{" "}
          <code>cli.github.com</code>, then check again.
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
  const [finishing, setFinishing] = useState(false);

  async function handleFinish() {
    setFinishing(true);
    try {
      await completeSetup();
      onFinish();
    } finally {
      setFinishing(false);
    }
  }

  return (
    <section>
      <p>Subject creation is coming in the next build step. You can finish setup now and add your first subject once it's ready.</p>
      <div className="setup-actions">
        <button type="button" onClick={onBack} disabled={finishing}>
          Back
        </button>
        <button type="button" onClick={handleFinish} disabled={finishing}>
          Finish setup
        </button>
      </div>
    </section>
  );
}
