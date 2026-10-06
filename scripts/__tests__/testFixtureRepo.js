// Shared helper for scripts/__tests__/*: check-privacy.js and
// install-hooks.js both resolve "repo root" from their OWN file location
// (import.meta.url / __dirname), not from any cwd a test could pass in —
// correct for the real repo, but it means testing them against a
// disposable fixture requires copying the actual shipped files into a
// throwaway git repo, so the fixture's "repo root" IS the dir containing
// the copy. Pointing git commands at a separate temp cwd while leaving the
// real files in place would silently test nothing.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REAL_SCRIPTS_DIR = path.resolve(__dirname, "..");
export const REAL_GITHOOKS_DIR = path.resolve(__dirname, "..", "..", ".githooks");

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/**
 * Creates a fresh git repo under a temp dir, with real copies of
 * scripts/check-privacy.js, scripts/install-hooks.js, and
 * .githooks/pre-commit — everything the privacy guard needs to run
 * exactly as it does in the real repo, committed as the initial state.
 */
export function createFixtureRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "athena-hooks-test-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, ".githooks"), { recursive: true });
  cpSync(path.join(REAL_SCRIPTS_DIR, "check-privacy.js"), path.join(dir, "scripts", "check-privacy.js"));
  cpSync(path.join(REAL_SCRIPTS_DIR, "install-hooks.js"), path.join(dir, "scripts", "install-hooks.js"));
  cpSync(path.join(REAL_GITHOOKS_DIR, "pre-commit"), path.join(dir, ".githooks", "pre-commit"));

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "fixture init"]);
  return dir;
}

export function removeFixtureRepo(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function runNodeScript(dir, relScriptPath, args) {
  try {
    const stdout = execFileSync("node", [path.join(dir, relScriptPath), ...args], { cwd: dir, encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

export function stageFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  git(dir, ["add", relPath]);
}

export function commit(dir, message) {
  return execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, encoding: "utf8" });
}

export function tryCommit(dir, message) {
  try {
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, encoding: "utf8" });
    return { code: 0 };
  } catch (err) {
    return { code: typeof err.status === "number" ? err.status : 1, stderr: err.stderr?.toString() ?? "" };
  }
}

export { git };
