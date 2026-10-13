// Regression test for the "blank console window flashes on every button
// click on Windows" bug (binabair, issue #2): the server runs from a
// hidden shortcut with no console of its own, so ANY child process it (or
// the installer/maintainer scripts) spawns without `windowsHide: true`
// pops open its own blank console window on Windows for the duration of
// the call. Fixing it once in processUtil.js covers every server-side
// `claude`/`gh`/`git` call, but the installer and maintainer scripts spawn
// `git`/`npm`/`node` directly (they can't depend on processUtil.js — see
// their own comments) and would silently regress if a future edit to one
// of them dropped the option. This statically scans each known spawn site's
// source text rather than exercising the real spawn (there's no way to
// observe "a console window didn't appear" from a non-Windows CI runner).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const SPAWN_FN_NAMES = ["spawn", "execFile", "execFileSync", "spawnSync", "exec", "execSync"];

/** Finds every call to one of the child_process-family function names in
 * `source` and returns the full call text (name through matching closing
 * paren), so callers can check each call's own options object rather than
 * just whether the word "windowsHide" appears anywhere in the file. */
function findSpawnCalls(source) {
  const calls = [];
  for (const name of SPAWN_FN_NAMES) {
    const re = new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g");
    let match;
    while ((match = re.exec(source))) {
      const openParenIndex = match.index + match[0].length - 1;
      let depth = 1;
      let i = openParenIndex + 1;
      while (i < source.length && depth > 0) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") depth--;
        i++;
      }
      calls.push({ name, text: source.slice(match.index, i) });
    }
  }
  return calls;
}

// Every file in this app (not test fixtures — those run in an already-open
// CI/terminal console and never ship to a friend's machine) that spawns a
// real external process, with the minimum number of spawn-family calls
// each is known to contain. The count guards against the regex above
// silently matching zero calls (e.g. after a refactor) and the test
// trivially passing having checked nothing.
const FILES_WITH_MIN_CALL_COUNTS = [
  ["server/src/processUtil.js", 2],
  ["installers/bootstrap.mjs", 2],
  ["installers/rollback.mjs", 1],
  ["scripts/install-hooks.js", 1],
  ["scripts/check-privacy.js", 3],
  ["scripts/promote-release.mjs", 1],
];

for (const [relPath, minCalls] of FILES_WITH_MIN_CALL_COUNTS) {
  test(`${relPath}: every spawn-family call sets windowsHide: true`, () => {
    const source = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
    const calls = findSpawnCalls(source);
    assert.ok(
      calls.length >= minCalls,
      `expected at least ${minCalls} spawn-family call(s) in ${relPath}, found ${calls.length} — ` +
        "did the scanner's regex stop matching this file's code?",
    );
    for (const call of calls) {
      assert.match(
        call.text,
        /windowsHide\s*:\s*true/,
        `${relPath}: a \`${call.name}(...)\` call is missing \`windowsHide: true\` — on Windows this ` +
          "pops open a blank console window every time it runs from a process with no console of its own " +
          "(e.g. the server started from the hidden shortcut). Call:\n" +
          call.text,
      );
    }
  });
}
