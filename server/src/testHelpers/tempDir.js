// Shared helper for tests that need a scratch directory under the OS temp
// dir. Every dir handed out here is tracked and removed in a single
// `after` hook registered at import time, so individual test files don't
// each need their own cleanup boilerplate (and can't forget it) — see the
// "Tests clean up their temp folders" commit for why this exists: leaked
// `athena-*` mkdtemp dirs were filling /tmp.
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const created = [];

after(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

/** Async: create a tracked temp dir under os.tmpdir() with the given prefix. */
export async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Sync variant of makeTempDir, for tests that aren't already async. */
export function makeTempDirSync(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
