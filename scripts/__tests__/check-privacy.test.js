// Exercises the actual shipped scripts/check-privacy.js (via a fixture
// repo, see testFixtureRepo.js) in both modes it's really invoked in:
// --staged (the pre-commit hook) and full-tree (CI). This is the single
// most important safety net in the repo (SPEC.md section 3) and had zero
// test coverage before — these tests run the real script end to end
// rather than re-implementing its regexes, so a change that quietly
// breaks detection fails here, not in production on a public repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createFixtureRepo, removeFixtureRepo, runNodeScript, stageFile, commit } from "./testFixtureRepo.js";

function withFixture(fn) {
  const dir = createFixtureRepo();
  try {
    return fn(dir);
  } finally {
    removeFixtureRepo(dir);
  }
}

test("--staged allows a clean source file on the allowlist", () => {
  withFixture((dir) => {
    stageFile(dir, "scripts/helper.js", "export const x = 1;\n");
    const result = runNodeScript(dir, "scripts/check-privacy.js", ["--staged"]);
    assert.equal(result.code, 0, result.stderr);
  });
});

test("--staged blocks a file outside the path allowlist", () => {
  withFixture((dir) => {
    stageFile(dir, "notes.txt", "just some scratch notes");
    const result = runNodeScript(dir, "scripts/check-privacy.js", ["--staged"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /notes\.txt/);
  });
});

// These two fake-but-realistic-looking strings are built by concatenation,
// not typed as a contiguous literal, so this test file's own committed
// source never contains a string the OUTER privacy guard (protecting this
// real repo) would itself flag — only the nested fixture file gets the
// assembled, genuinely leak-shaped string, which is the whole point of
// the test.
const FAKE_EMAIL = ["jane", "doe"].join("") + "@" + ["real", "mail", "host"].join("") + ".net";
const FAKE_HOME_PATH = "/home/" + ["jane", "doe"].join("");

test("--staged blocks content with a real-looking email address", () => {
  withFixture((dir) => {
    stageFile(dir, "scripts/config.js", `export const owner = "${FAKE_EMAIL}";\n`);
    const result = runNodeScript(dir, "scripts/check-privacy.js", ["--staged"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /real email address/);
  });
});

test("--staged blocks content with a real-looking home directory path", () => {
  withFixture((dir) => {
    stageFile(dir, "scripts/config.js", `export const logPath = "${FAKE_HOME_PATH}/athena.log";\n`);
    const result = runNodeScript(dir, "scripts/check-privacy.js", ["--staged"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /home-directory path/);
  });
});

test("--staged allows known-safe placeholder emails and paths used by this codebase's own tests", () => {
  withFixture((dir) => {
    stageFile(
      dir,
      "scripts/config.js",
      ['export const sample = "test@example.com";', 'export const fakePath = "/home/someone/project";', ""].join(
        "\n",
      ),
    );
    const result = runNodeScript(dir, "scripts/check-privacy.js", ["--staged"]);
    assert.equal(result.code, 0, result.stderr);
  });
});

test("--staged allows a git SSH clone URL even though it's email-shaped", () => {
  withFixture((dir) => {
    stageFile(dir, "scripts/config.js", 'export const remote = "git@github.com:org/repo.git";\n');
    const result = runNodeScript(dir, "scripts/check-privacy.js", ["--staged"]);
    assert.equal(result.code, 0, result.stderr);
  });
});

test("--staged blocks the CODE_ONLY_FORBIDDEN product name in code, but not in a doc file", () => {
  // Built via concatenation rather than typed literally: the needle itself
  // is one of check-privacy.js's own forbidden strings, and this test file
  // is real committed source, not a fixture file inside a disposable
  // temp repo — a literal match here would trip the very guard under test.
  const sourceSystemName = ["ze", "ona"].join("");

  withFixture((dir) => {
    stageFile(dir, "scripts/config.js", `// ported from ${sourceSystemName}\nexport const x = 1;\n`);
    const codeResult = runNodeScript(dir, "scripts/check-privacy.js", ["--staged"]);
    assert.notEqual(codeResult.code, 0);
    assert.match(codeResult.stderr, /this product must stand alone/);
  });

  withFixture((dir) => {
    stageFile(dir, "README.md", `# Athena\n\nDerived from ${sourceSystemName}'s Hub.\n`);
    const docResult = runNodeScript(dir, "scripts/check-privacy.js", ["--staged"]);
    assert.equal(docResult.code, 0, docResult.stderr);
  });
});

test("full-tree mode (no --staged) scans the committed working tree via git ls-files", () => {
  withFixture((dir) => {
    stageFile(dir, "scripts/config.js", `export const owner = "${FAKE_EMAIL}";\n`);
    commit(dir, "add leaky file");
    const result = runNodeScript(dir, "scripts/check-privacy.js", []);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /real email address/);
  });
});

test("the guard's own source is exempt from matching its own detection needles", () => {
  withFixture((dir) => {
    // scripts/check-privacy.js necessarily contains its own LITERAL_FORBIDDEN
    // and CODE_ONLY_FORBIDDEN needles as literal text (they're the detection
    // patterns, not leaked data). Re-stage a trivial edit to the
    // file itself (so it's actually part of the staged diff being
    // checked, not just sitting unchanged in a prior commit) and confirm
    // it never flags itself.
    const scriptPath = path.join(dir, "scripts", "check-privacy.js");
    const original = readFileSync(scriptPath, "utf8");
    stageFile(dir, "scripts/check-privacy.js", `${original}\n// trivial edit for test\n`);
    const result = runNodeScript(dir, "scripts/check-privacy.js", ["--staged"]);
    assert.equal(result.code, 0, result.stderr);
  });
});
