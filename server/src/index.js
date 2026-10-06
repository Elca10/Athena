// Athena-Studying backend entry point. Local-only web app (SPEC.md section
// 2: "Binds to localhost only") — serves the built frontend (web/dist) plus
// a small JSON API, and (in build step 3+) spawns the user's own `claude`
// CLI in headless mode, the same subscription-driven pattern this product
// is modelled on (SPEC.md section 2). Build step 1 only needs: health, and
// first-run setup checks.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, HOST } from "./config.js";
import { getAppDataDir, ensureAppDataDir } from "./dataDir.js";
import { healthRouter } from "./routes/health.js";
import { makeSetupRouter } from "./routes/setup.js";
import { makeSubjectsRouter } from "./routes/subjects.js";
import { makeContentRouter } from "./routes/content.js";
import { makeTopicsRouter } from "./routes/topics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createApp() {
  const appDataDir = getAppDataDir();
  await ensureAppDataDir(appDataDir);

  const app = express();
  app.use(express.json());

  // Never cache API responses: a stale cached GET served from the
  // browser's HTTP cache with no revalidation request is a known,
  // easy-to-hit bug class in local web apps like this one, cheap to rule
  // out up front rather than rediscover later.
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use("/api/health", healthRouter(appDataDir));
  app.use("/api/setup", makeSetupRouter(appDataDir));
  app.use("/api/subjects", makeSubjectsRouter(appDataDir));
  app.use("/api/subjects/:id/content", makeContentRouter(appDataDir));
  app.use("/api/subjects/:id/topics", makeTopicsRouter(appDataDir));

  const distDir = path.resolve(__dirname, "..", "..", "web", "dist");
  app.use(express.static(distDir));
  // SPA fallback: any unmatched non-API GET serves index.html so client-side
  // routing (if/when the frontend adds any) works on a hard refresh too.
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    res.sendFile(path.join(distDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });

  return { app, appDataDir };
}

async function main() {
  const { app, appDataDir } = await createApp();
  app.listen(PORT, HOST, () => {
    console.log(`Athena-Studying backend listening on http://${HOST}:${PORT}`);
    console.log(`App data dir: ${appDataDir}`);
  });
}

// Only auto-start when run directly (`node src/index.js`), not when
// imported by tests (createApp is exported precisely so tests can spin up
// an app on an ephemeral port instead).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
