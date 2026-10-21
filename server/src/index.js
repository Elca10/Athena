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
import { MAX_BINARY_CONTENT_BYTES, backfillTopicSources } from "./content.js";
import { makeTopicsRouter } from "./routes/topics.js";
import { makeSessionsRouter } from "./routes/sessions.js";
import { makeReflectionsRouter } from "./routes/reflections.js";
import { makeDeadlinesRouter } from "./routes/deadlines.js";
import { makeScheduleRouter } from "./routes/schedule.js";
import { makeStatsRouter } from "./routes/stats.js";
import { makePreferencesRouter } from "./routes/preferences.js";
import { makeBugReportRouter } from "./routes/bugReport.js";
import { makeUpdateRouter } from "./routes/update.js";
import { makeUpdateChecker, updateBranch } from "./updateCheck.js";
import { makeUpdateApplier } from "./updateApply.js";
import { recordError } from "./errorLog.js";
import { getAppVersion } from "./bugReport.js";
import { reconcileInterruptedSessions } from "./sessions.js";
import { getSubject } from "./subjects.js";
import { keepBankAhead } from "./questionBankGeneration.js";
import { ensureKnownCliDirsOnPath } from "./processUtil.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createApp() {
  const appDataDir = getAppDataDir();
  await ensureAppDataDir(appDataDir);
  // Resolved ONCE, at startup: the commit this process is actually running.
  // Asking git on every request reports whatever the checkout holds NOW,
  // which an installer re-run can change underneath a still-running server
  // (issue #4: a bug report claimed the newest commit while older code was
  // serving it).
  const repoDir = path.resolve(__dirname, "..", "..");
  const appVersion = getAppVersion(repoDir);
  // Created here, but only main() starts its periodic `git fetch`, so a
  // test calling createApp() never reaches out to the real remote.
  const updateChecker = makeUpdateChecker({ repoDir });
  const updateApplier = makeUpdateApplier({
    checker: updateChecker,
    repoDir,
    appDataDir,
    port: PORT,
    branch: updateBranch(),
  });

  const app = express();
  // Default (100kb) is too small for a plain-text upload (content.js caps
  // those at 2MB; JSON escaping can roughly double that). Binary files
  // don't come through here at all: routes/content.js's /file route takes
  // raw bytes with its own limit.
  app.use(express.json({ limit: "8mb" }));

  // Never cache API responses: a stale cached GET served from the
  // browser's HTTP cache with no revalidation request is a known,
  // easy-to-hit bug class in local web apps like this one, cheap to rule
  // out up front rather than rediscover later.
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Before every router: tracks in-flight requests and turns new ones away
  // while an update is draining (updateApply.js).
  app.use("/api", updateApplier.middleware);

  app.use("/api/health", healthRouter(appDataDir, appVersion));
  app.use("/api/setup", makeSetupRouter(appDataDir));
  app.use("/api/subjects", makeSubjectsRouter(appDataDir));
  app.use("/api/subjects/:id/content", makeContentRouter(appDataDir));
  app.use("/api/subjects/:id/topics", makeTopicsRouter(appDataDir));
  app.use("/api/subjects/:id/reflections", makeReflectionsRouter(appDataDir));
  app.use("/api/subjects/:id/deadlines", makeDeadlinesRouter(appDataDir));
  app.use("/api/schedule", makeScheduleRouter(appDataDir));
  app.use(
    "/api/sessions",
    makeSessionsRouter(appDataDir, {
      // After a Ready session, write the next chunk of practice questions
      // in the background (issue #10). Never blocks the response.
      onReadySessionDone: (session) => {
        for (const subjectId of session.subjectIds) {
          getSubject(appDataDir, subjectId)
            .then((subject) => subject && keepBankAhead(appDataDir, subjectId, { subjectName: subject.name }))
            .then((result) => result?.errors?.length && recordError(`keepBankAhead: ${result.errors.join("; ").slice(0, 300)}`))
            .catch((err) => recordError(`keepBankAhead: ${err.message ?? err}`));
        }
      },
    }),
  );
  app.use("/api/stats", makeStatsRouter(appDataDir));
  app.use("/api/preferences", makePreferencesRouter(appDataDir));
  app.use("/api/bug-report", makeBugReportRouter(appDataDir, { appVersion }));
  app.use("/api/update", makeUpdateRouter(updateChecker, { applier: updateApplier, appDataDir }));

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
    // A body over a parser's limit is the user's file being too big, not a
    // server fault: say so plainly (it used to surface as a bare
    // "request entity too large").
    if (err.type === "entity.too.large") {
      res.status(413).json({ error: `That file is too big. The limit is ${Math.round(MAX_BINARY_CONTENT_BYTES / 1024 / 1024)} MB per file.` });
      return;
    }
    recordError(`${err.message ?? err}`);
    res.status(500).json({ error: "Something went wrong." });
  });

  return { app, appDataDir, updateChecker };
}

async function main() {
  // Before anything can shell out to `claude`: a server launched from a
  // terminal opened before Claude Code was installed has a stale PATH.
  ensureKnownCliDirsOnPath();
  const { app, appDataDir, updateChecker } = await createApp();
  updateChecker.start();
  const server = app.listen(PORT, HOST, async () => {
    console.log(`Athena-Studying backend listening on http://${HOST}:${PORT}`);
    console.log(`App data dir: ${appDataDir}`);
    // Only once listen succeeded: if another server already held this port,
    // its sessions may genuinely be mid-turn and must not be touched.
    const moved = await reconcileInterruptedSessions(appDataDir).catch((err) => {
      recordError(`reconcileInterruptedSessions: ${err.message}`);
      return 0;
    });
    if (moved) console.log(`Moved ${moved} interrupted session(s) to Waiting.`);
    // Topics from before source tracking: link them to their files once.
    const linked = await backfillTopicSources(appDataDir).catch((err) => {
      recordError(`backfillTopicSources: ${err.message}`);
      return 0;
    });
    if (linked) console.log(`Checked ${linked} older topic(s) for which files they came from.`);
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
