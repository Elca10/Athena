#!/usr/bin/env node
// Regression guard for "tests clean up their temp folders" (every test
// that calls mkdtemp/mkdtempSync must remove what it creates, even on
// failure — see server/src/testHelpers/tempDir.js and the per-suite
// try/finally blocks across installers/__tests__ and scripts/__tests__).
//
// Compares the actual SET of `athena-*` entries in os.tmpdir() before and
// after a run, not just a count, so this can't be fooled by an unrelated
// entry appearing and a leaked one disappearing in the same window (or
// the reverse, which a count-only comparison could misreport as a leak).
// That's intentionally only safe to run in CI, where this job has a
// runner to itself — nothing else on the machine is creating its own
// athena-* temp dirs at the same time, which a real dev machine (e.g. one
// running several Athena test runs at once) can't promise.
//
// Usage:
//   node scripts/ci/tmpDirGuard.mjs snapshot <snapshotFile>   (run first)
//   node scripts/ci/tmpDirGuard.mjs check <snapshotFile>      (run last)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

const [, , mode, snapshotPath] = process.argv;

function listAthenaEntries() {
  return readdirSync(os.tmpdir()).filter((name) => name.startsWith("athena-"));
}

if (mode === "snapshot" && snapshotPath) {
  writeFileSync(snapshotPath, JSON.stringify(listAthenaEntries()));
  process.exit(0);
}

if (mode === "check" && snapshotPath) {
  const before = new Set(JSON.parse(readFileSync(snapshotPath, "utf8")));
  const after = listAthenaEntries();
  const leaked = after.filter((name) => !before.has(name));
  if (leaked.length > 0) {
    console.error(
      `Temp-dir guard: ${leaked.length} new athena-* entr${leaked.length === 1 ? "y" : "ies"} left behind in ${os.tmpdir()} ` +
        `after this run — a test (or test helper) isn't cleaning up what it created:`,
    );
    for (const name of leaked) console.error(`  ${name}`);
    process.exit(1);
  }
  console.log(`Temp-dir guard: no new athena-* entries left behind in ${os.tmpdir()}.`);
  process.exit(0);
}

console.error("Usage: node scripts/ci/tmpDirGuard.mjs <snapshot|check> <snapshotFilePath>");
process.exit(1);
