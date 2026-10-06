// Minimal atomic JSON read/write for this app's small state files (the
// first-run "setup complete" marker, the auto-updater's "last known-good
// commit" record — see updater/autoUpdate.js). Deliberately NOT a full
// per-key-locking store with backup-before-overwrite (a heavier pattern
// that solves problems caused by many concurrent writers hitting the same
// file) — that doesn't apply here: these are single-writer, written-rarely
// files. The one bug class that *does* apply even here — a crash leaving a
// half-written file — is cheap to rule out regardless: write to a temp
// file in the same directory, then rename, which is atomic on both POSIX
// and Windows
// (NTFS) for same-volume renames.
//
// Real per-subject/topic/attempt data storage is a build-step-2 decision
// (SPEC.md section 11) — see that step's own notes once it exists.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

export async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2));
  await fs.rename(tmpPath, filePath);
}
