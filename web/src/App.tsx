import { useEffect, useState } from "react";
import { getHealth } from "./setup/api";
import { SetupWizard } from "./setup/SetupWizard";

export default function App() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);

  useEffect(() => {
    getHealth().then((health) => setSetupComplete(health.setupComplete));
  }, []);

  if (setupComplete === null) return <p>Loading...</p>;

  if (!setupComplete) {
    return <SetupWizard onComplete={() => setSetupComplete(true)} />;
  }

  // The real dashboard (SPEC.md section 4) lands in later build steps.
  return <p>Setup complete. The dashboard is under construction.</p>;
}
