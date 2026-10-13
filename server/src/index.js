// Athena-Studying backend entry point. Local-only web app (SPEC.md section
// 2: "Binds to localhost only") — serves the built frontend (web/dist) plus
// a small JSON API, and (in build step 3+) spawns the user's own `claude`
// CLI in headless mode, the same subscription-driven pattern this product
// is modelled on (SPEC.md section 2). Build step 1 only needs: health, and
// first-run setup checks.

import express from "express";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PORT, HOST } from "./config.js";
import { getAppDataDir, ensureAppDataDir } from "./dataDir.js";
import { healthRouter } from "./routes/health.js";
import { makeSetupRouter } from "./routes/setup.js";
import { makeSubjectsRouter } from "./routes/subjects.js";
import { makeContentRouter } from "./routes/content.js";
import { makeTopicsRouter } from "./routes/topics.js";
import { makeSessionsRouter } from "./routes/sessions.js";
import { makeReflectionsRouter } from "./routes/reflections.js";
import { makeStatsRouter } from "./routes/stats.js";
import { makePreferencesRouter } from "./routes/preferences.js";
import { makeBugReportRouter } from "./routes/bugReport.js";
import { recordError } from "./errorLog.js";
import { ensureKnownCliDirsOnPath } from "./processUtil.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createApp() {
  const appDataDir = getAppDataDir();
  await ensureAppDataDir(appDataDir);

  const app = express();
  // Default (100kb) is too small for a base64-encoded PDF upload
  // (content.js's MAX_BINARY_CONTENT_BYTES is 25MB raw, ~33% bigger
  // base64-encoded); raised for the whole app rather than scoped to the
  // content route alone, since Express runs this parser ahead of route
  // matching and a request over the old limit would be rejected before
  // ever reaching a route-specific one. Fine for a local-only,
  // single-user app bound to 127.0.0.1 (SPEC.md section 2) — there's no
  // untrusted caller to harden this against.
  app.use(express.json({ limit: "35mb" }));

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
  app.use("/api/subjects/:id/reflections", makeReflectionsRouter(appDataDir));
  app.use("/api/sessions", makeSessionsRouter(appDataDir));
  app.use("/api/stats", makeStatsRouter(appDataDir));
  app.use("/api/preferences", makePreferencesRouter(appDataDir));
  app.use("/api/bug-report", makeBugReportRouter(appDataDir));

  const distDir = path.resolve(__dirname, "..", "..", "web", "dist");
  app.use(express.static(distDir));
  // SPA fallback: any unmatched non-API GET serves index.html so client-side
  // routing (if/when the frontend adds any) works on a hard refresh too.
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    res.sendFile(path.join(distDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });

  // Last-resort error handler (Express identifies it by its 4-arg
  // signature): records the error so it can show up in a future bug
  // report's "recent server errors" diagnostic (errorLog.js), then
  // answers with a generic 500 — never the raw error message/stack,
  // which could contain a file path or other local detail, straight to
  // the browser.
  app.use((err, _req, res, _next) => {
    recordError(`${err.message ?? err}`);
    res.status(500).json({ error: "Something went wrong." });
  });

  return { app, appDataDir };
}

async function main() {
  // Before anything can shell out to `claude`: a server launched from a
  // terminal opened before Claude Code was installed has a stale PATH.
  ensureKnownCliDirsOnPath();
  const { app, appDataDir } = await createApp();
  app.listen(PORT, HOST, () => {
    console.log(`Athena-Studying backend listening on http://${HOST}:${PORT}`);
    console.log(`App data dir: ${appDataDir}`);
  });
}

// Only auto-start when run directly (`node src/index.js`), not when
// imported by tests (createApp is exported precisely so tests can spin up
// an app on an ephemeral port instead). pathToFileURL, not a bare
// `file://${...}` template: process.argv[1] is a native OS path
// (backslashes, no `file://` prefix on Windows), and only pathToFileURL
// converts it the same way Node itself builds import.meta.url — the naive
// template version happens to work on POSIX but can never match on
// Windows, so this never ran there at all.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
