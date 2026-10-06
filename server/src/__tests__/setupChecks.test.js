import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { checkClaudeCode, checkGh, interpretClaudeUsageOutput, interpretGhAuthStatus } from "../setupChecks.js";

// An env whose PATH points nowhere real — guarantees ENOENT for any CLI
// lookup regardless of what's actually installed on the machine running
// this test (this dev Pi genuinely has `claude` installed; a CI runner
// genuinely doesn't have either — this makes the "not installed" branch
// deterministic either way).
function emptyPathEnv() {
  return { PATH: os.tmpdir() };
}

test("interpretClaudeUsageOutput: exit 0 + 'used' text means logged in", () => {
  const result = interpretClaudeUsageOutput({
    code: 0,
    stdout: "Current session: 12% used · resets ...",
    stderr: "",
  });
  assert.deepEqual(result, { loggedIn: true });
});

test("interpretClaudeUsageOutput: nonzero exit + login wording means logged out", () => {
  const result = interpretClaudeUsageOutput({
    code: 1,
    stdout: "",
    stderr: "Please run /login to authenticate.",
  });
  assert.equal(result.loggedIn, false);
  assert.match(result.detail, /login/i);
});

test("interpretClaudeUsageOutput: ambiguous output is reported as unknown, not guessed", () => {
  const result = interpretClaudeUsageOutput({ code: 0, stdout: "something unexpected", stderr: "" });
  assert.equal(result.loggedIn, null);
});

test("interpretGhAuthStatus: exit 0 means authenticated", () => {
  assert.deepEqual(interpretGhAuthStatus({ code: 0, stdout: "Logged in to github.com", stderr: "" }), {
    authenticated: true,
    detail: "Logged in to github.com",
  });
});

test("interpretGhAuthStatus: nonzero exit means not authenticated", () => {
  const result = interpretGhAuthStatus({ code: 1, stdout: "", stderr: "You are not logged into any accounts" });
  assert.equal(result.authenticated, false);
});

test("checkClaudeCode reports not installed when the binary can't be found", async () => {
  const result = await checkClaudeCode({ env: emptyPathEnv() });
  assert.equal(result.installed, false);
});

test("checkGh reports not installed when the binary can't be found", async () => {
  const result = await checkGh({ env: emptyPathEnv() });
  assert.equal(result.installed, false);
});
