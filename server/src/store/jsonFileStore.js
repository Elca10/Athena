// A hardened JSON-file-backed store for Athena's own per-entity data —
// subjects, and later topics/attempts/question banks (SPEC.md section
// 11's storage-engine decision: plain JSON files on disk, not a
// database). Guards against two real failure classes a comparable
// JSON-file store elsewhere has hit in production:
//   - an in-process lock, so concurrent writers within this one server
//     process serialize instead of interleaving;
//   - an atomic temp-file + rename, so even a second process racing this
//     one (e.g. an overlapping auto-update restart) can't tear bytes;
//   - a best-effort, throttled backup-before-overwrite snapshot, so a
//     write that is wrong but legitimate-looking from its own point of
//     view can never erase the previous good copy outright.
//
// Deliberately takes `dir` as an explicit argument on every call rather
// than resolving a data-dir env var at module load — that sidesteps the
// "a test imported this before the env override was set" bug class by
// construction, matching this codebase's existing DI convention
// (dataDir.js, setupState.js). This is also a single-user local app with
// one server process at a time, so there's no need for the kind of
// shared, env-var-driven data-dir override a multi-session dev setup
// would otherwise want.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_BACKUPS_PER_FILE = 20;
let minBackupIntervalMs = 60_000;
const lastBackupAt = new Map();

// Test-only escape hatch: tests need to prove multiple backups accumulate
// and get pruned without actually waiting a minute per write.
export function __setBackupThrottleForTests(ms) {
  minBackupIntervalMs = ms;
}

async function backupBeforeOverwrite(fileName, filePath, backupDir) {
  const now = Date.now();
  if (now - (lastBackupAt.get(filePath) ?? 0) < minBackupIntervalMs) return;
  let current;
  try {
    current = await fs.readFile(filePath, "utf8");
  } catch {
    return; // nothing on disk yet for this file — nothing to protect
  }
  if (!current.trim()) return;
  try {
    JSON.parse(current); // never let a backup preserve/propagate corruption
  } catch {
    return;
  }
  try {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, `${fileName}.${now}.bak`), current);
    lastBackupAt.set(filePath, now);
    const entries = await fs.readdir(backupDir);
    const mine = entries.filter((e) => e.startsWith(`${fileName}.`) && e.endsWith(".bak")).sort();
    const excess = mine.length - MAX_BACKUPS_PER_FILE;
    for (let i = 0; i < excess; i++) {
      await fs.unlink(path.join(backupDir, mine[i])).catch(() => {});
    }
  } catch (err) {
    console.error(`backupBeforeOverwrite(${fileName}): best-effort backup failed, continuing with the real write:`, err.message);
  }
}

const queues = new Map();

function withLock(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  queues.set(key, result.catch(() => {}));
  return result;
}

/**
 * `dir` is the directory the file lives in — caller resolves it (e.g. via
 * `appDataSubdirs(appDataDir).db`); see the file header for why this
 * module never resolves a data-dir env var itself. Locks and backup
 * bookkeeping are keyed by the full resolved file path, so two stores in
 * different directories can never collide even if `fileName` matches.
 */
export function makeJsonFileStore(dir, fileName, defaultValue) {
  const filePath = path.join(dir, fileName);
  const backupDir = path.join(dir, "backups");

  // A fresh copy each time: handing out the shared `defaultValue` object
  // would let one caller mutating its result in place silently change
  // what every later read of a missing file returns.
  async function read() {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return raw.trim() ? JSON.parse(raw) : structuredClone(defaultValue);
    } catch (err) {
      if (err.code === "ENOENT") return structuredClone(defaultValue);
      throw err;
    }
  }

  async function write(value) {
    await fs.mkdir(dir, { recursive: true });
    await backupBeforeOverwrite(fileName, filePath, backupDir);
    const tmpPath = path.join(dir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(value, null, 2));
    await fs.rename(tmpPath, filePath);
  }

  /** Read-modify-write under this file's lock — the only safe way to do a
   * read followed by a write; two separate `read()`/`write()` calls race
   * (a real lost-update incident in a comparable store elsewhere: two
   * overlapping callers both read the same pre-write snapshot, and the
   * later write clobbered the earlier one's fresh data). `mutator` gets
   * the current value and returns the new one. */
  async function update(mutator) {
    return withLock(filePath, async () => {
      const current = await read();
      const next = await mutator(current);
      await write(next);
      return next;
    });
  }

  return { read, write, update };
}
