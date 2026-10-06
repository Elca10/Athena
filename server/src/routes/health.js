import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSetupComplete } from "../setupState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));

export function healthRouter(appDataDir) {
  const router = express.Router();

  // Polled by the frontend AND by the auto-updater's startup health check
  // (SPEC.md section 2) — a successful response here is literally the
  // definition of "this version started successfully." Keep this cheap
  // and dependency-free: it must stay reliable even when something else
  // in the app is broken, since that's exactly when the updater needs it
  // to answer honestly.
  router.get("/", async (_req, res) => {
    res.json({
      ok: true,
      version: pkg.version,
      setupComplete: await isSetupComplete(appDataDir),
    });
  });

  return router;
}
