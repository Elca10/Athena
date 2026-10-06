import path from "node:path";
import { readJson, writeJsonAtomic } from "./atomicJson.js";

function markerPath(appDataDir) {
  return path.join(appDataDir, "setup-complete.json");
}

export async function isSetupComplete(appDataDir) {
  const data = await readJson(markerPath(appDataDir), null);
  return data?.complete === true;
}

export async function markSetupComplete(appDataDir) {
  await writeJsonAtomic(markerPath(appDataDir), { complete: true, completedAt: new Date().toISOString() });
}
