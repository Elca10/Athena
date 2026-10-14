import { useEffect, useState } from "react";
import { getHealth } from "./setup/api";
import { SetupWizard } from "./setup/SetupWizard";
import { Dashboard } from "./dashboard/Dashboard";

export default function App() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  function load() {
    setUnreachable(false);
    getHealth()
      .then((health) => setSetupComplete(health.setupComplete))
      .catch(() => setUnreachable(true));
  }

  useEffect(load, []);

  // Without this, a server that wasn't answering left "Loading..." up forever.
  if (unreachable) {
    return (
      <div className="app-unreachable" role="alert">
        <p>Couldn't reach Athena. It may still be starting up, or it isn't running.</p>
        <button type="button" className="btn-primary" onClick={load}>
          Try again
        </button>
      </div>
    );
  }

  if (setupComplete === null) return <p>Loading...</p>;

  if (!setupComplete) {
    return <SetupWizard onComplete={() => setSetupComplete(true)} />;
  }

  return <Dashboard />;
}
