// Resolves the one directory where ALL of this user's Athena-Studying data
// lives — subjects, topics, attempts, question banks, parsed course
// content, preferences, session transcripts, logs, and the auto-updater's
// own state (SPEC.md section 3: "All user data lives outside the repo
// checkout"). Nothing under the git checkout may ever hold user data, even
// by accident — this module is the one place that decides where it goes
// instead, so every store/log/upload path in the app comes from here
// rather than each module inventing its own relative path.
//
// Per-OS defaults, following the same convention most desktop apps use:
//   macOS   - ~/Library/Application Support/Athena-Studying
//   Windows - %APPDATA%\Athena-Studying   (APPDATA is always set by Windows)
//   Linux   - $XDG_DATA_HOME/athena-studying, falling back to
//             ~/.local/share/athena-studying (useful for the maintainer's
//             own Linux dev/CI runs; Linux isn't a target platform per the
//             spec, but there's no reason to crash on it)
//
// `ATHENA_DATA_DIR` always wins when set — needed for tests (never touch a
// real user's data dir from a test run) and for anyone who wants their
// data somewhere else on purpose.
//
// Deliberately pure path logic with no fs side effects beyond
// `ensureAppDataDir`'s mkdir — keeps this trivially unit-testable (just
// swap env/platform in) and lets callers choose when the directory should
// actually be created.

import path from "node:path";
import os from "node:os";

export const APP_NAME = "Athena-Studying";

// Linux dir-name convention is lowercase-hyphenated, matching XDG norms
// (e.g. ~/.local/share/athena-studying), not the mixed-case macOS/Windows
// display name.
const LINUX_DIR_NAME = "athena-studying";

/**
 * Pure function: given an env map and a platform string (`process.platform`
 * values: "darwin", "win32", anything else treated as Linux/POSIX), returns
 * the app-data directory path. Exported separately from
 * `getAppDataDir`/`ensureAppDataDir` so tests can exercise every OS branch
 * without actually being on that OS.
 */
export function resolveAppDataDir(env, platform, homedir) {
  if (env.ATHENA_DATA_DIR) return env.ATHENA_DATA_DIR;

  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", APP_NAME);
  }

  if (platform === "win32") {
    // APPDATA (Roaming) is set by Windows for every user session; fall back
    // to a same-shaped path under the home dir on the off chance it's
    // missing (e.g. a stripped-down CI runner), rather than throwing.
    const appData = env.APPDATA || path.join(homedir, "AppData", "Roaming");
    return path.join(appData, APP_NAME);
  }

  // Linux and anything else POSIX-like.
  const xdgDataHome = env.XDG_DATA_HOME || path.join(homedir, ".local", "share");
  return path.join(xdgDataHome, LINUX_DIR_NAME);
}

/** Real (non-test) entry point: resolves against the actual process env/OS. */
export function getAppDataDir() {
  return resolveAppDataDir(process.env, process.platform, os.homedir());
}

/** Subdirectories under the app-data dir that callers can rely on existing
 * once `ensureAppDataDir` has run. Centralized here so every module that
 * needs e.g. the uploads dir agrees on its name. */
export function appDataSubdirs(baseDir) {
  return {
    base: baseDir,
    db: path.join(baseDir, "db"),
    content: path.join(baseDir, "content"), // raw + parsed uploaded course material
    logs: path.join(baseDir, "logs"),
    updater: path.join(baseDir, "updater"), // auto-update/rollback state (section 2)
  };
}

export async function ensureAppDataDir(baseDir = getAppDataDir()) {
  const { promises: fs } = await import("node:fs");
  const dirs = appDataSubdirs(baseDir);
  for (const dir of Object.values(dirs)) {
    await fs.mkdir(dir, { recursive: true });
  }
  return dirs;
}
