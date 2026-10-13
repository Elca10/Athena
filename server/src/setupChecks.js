// First-run setup screen, step 1 & 2 (SPEC.md section 2): cheap checks for
// "is Claude Code installed and logged in" and "is the GitHub CLI
// installed and authenticated". Both are read-only, side-effect-free, and
// cost no model inference — `claude -p -- "/usage"` is answered locally by
// the CLI itself, never a real model turn.

import { ensureKnownCliDirsOnPath, runCommand } from "./processUtil.js";

/**
 * Detects the OS the server is actually running on (SPEC.md section 2;
 * v1.0 ship scope item 3a: the setup wizard's very first step pre-selects
 * this, but the user must still confirm it explicitly — a browser running
 * on a different machine than the server, or Node's own platform naming
 * being surprising, are both real enough that a silent auto-pick would be
 * wrong sometimes). Only `windows`/`mac` are real options — those are the
 * only two platforms `installers/` has a script for — `other` covers
 * anything else (e.g. Linux, this very build's own dev machine) with no
 * pre-selection, forcing an explicit choice rather than guessing between
 * two instruction sets neither of which may be right. `platform` is
 * injectable (defaults to the real `process.platform`) so this is
 * testable on every OS without actually running on one — same `{env}`-
 * style DI seam `checkClaudeCode`/`checkGh` use for the real CLI calls.
 */
export function detectOs(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "mac";
  return "other";
}

/**
 * Pure interpretation of `claude -p -- "/usage"`'s result — factored out of
 * `checkClaudeCode` so the login-state heuristic is unit-testable without
 * spawning a real process (and without needing the real CLI installed,
 * which CI runners won't have). Returns `{loggedIn: true|false|null,
 * detail?}` — `null` means "ambiguous output, can't tell" rather than a
 * guess either way, since a future CLI version rewording its output
 * (`/usage`'s text has changed across CLI releases before) should surface
 * as "unknown", not a silently wrong answer.
 */
export function interpretClaudeUsageOutput({ code, stdout, stderr }) {
  const output = `${stdout}\n${stderr}`;
  const looksLoggedOut = code !== 0 && /\b(log ?in|not authenticated|please run)\b/i.test(output);
  const looksLoggedIn = code === 0 && /used/i.test(output);

  if (looksLoggedIn) return { loggedIn: true };
  if (looksLoggedOut) return { loggedIn: false, detail: output.trim() };
  return { loggedIn: null, detail: output.trim() };
}

/**
 * Checks whether the `claude` CLI is installed and logged in to a Claude
 * account. Returns one of:
 *   { installed: false, detail? }
 *   { installed: true, loggedIn: true|false|null, detail? }
 * `detail` carries whatever the CLI actually printed, for a friend to paste
 * into a bug report if the check result is confusing.
 */
export async function checkClaudeCode({ env } = {}) {
  // Re-checked on every call (not just at startup) so "Check again" picks
  // up a Claude Code installed while this server was already running.
  if (!env) ensureKnownCliDirsOnPath();
  let versionResult;
  try {
    // Generous timeout: the first-ever launch of a freshly installed
    // claude.exe can take well over 5s while Windows Defender scans it,
    // and a timeout here would misreport a working install as missing.
    versionResult = await runCommand("claude", ["--version"], { timeoutMs: 30_000, env });
  } catch (err) {
    if (err.notFound) return { installed: false };
    return { installed: false, detail: `Could not run \`claude --version\`: ${err.message}` };
  }
  if (versionResult.code !== 0) {
    return { installed: false, detail: versionResult.stderr || versionResult.stdout };
  }

  let usageResult;
  try {
    // `--` terminates the flag list so the literal string "/usage" is
    // always read as the prompt, never as an option — see Ada's memory of
    // the `claude -p` "unknown option" bug class this avoids.
    usageResult = await runCommand("claude", ["-p", "--", "/usage"], { timeoutMs: 45_000, env });
  } catch (err) {
    return { installed: true, loggedIn: false, detail: `Could not run \`claude -p -- "/usage"\`: ${err.message}` };
  }

  return { installed: true, ...interpretClaudeUsageOutput(usageResult) };
}

/**
 * Pure interpretation of `gh auth status`'s result — exit code 0 means
 * authenticated, matching gh's own documented contract. Factored out for
 * the same testability reason as `interpretClaudeUsageOutput` above.
 */
export function interpretGhAuthStatus({ code, stdout, stderr }) {
  return {
    authenticated: code === 0,
    detail: (stdout + stderr).trim() || undefined,
  };
}

/** Checks whether the GitHub CLI is installed and authenticated.
 * Returns `{ installed, authenticated?, detail? }`. */
export async function checkGh({ env } = {}) {
  let versionResult;
  try {
    versionResult = await runCommand("gh", ["--version"], { timeoutMs: 5_000, env });
  } catch (err) {
    if (err.notFound) return { installed: false };
    return { installed: false, detail: `Could not run \`gh --version\`: ${err.message}` };
  }
  if (versionResult.code !== 0) {
    return { installed: false, detail: versionResult.stderr || versionResult.stdout };
  }

  let statusResult;
  try {
    statusResult = await runCommand("gh", ["auth", "status"], { timeoutMs: 10_000, env });
  } catch (err) {
    return { installed: true, authenticated: false, detail: `Could not run \`gh auth status\`: ${err.message}` };
  }

  return { installed: true, ...interpretGhAuthStatus(statusResult) };
}
