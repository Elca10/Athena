import { useEffect, useState } from "react";
import { getHealth } from "./setup/api";
import { SetupWizard } from "./setup/SetupWizard";
import { Dashboard } from "./dashboard/Dashboard";

export default function App() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);

  useEffect(() => {
    getHealth().then((health) => setSetupComplete(health.setupComplete));
  }, []);

  if (setupComplete === null) return <p>Loading...</p>;

  if (!setupComplete) {
    return <SetupWizard onComplete={() => setSetupComplete(true)} />;
  }

  return <Dashboard />;
}
