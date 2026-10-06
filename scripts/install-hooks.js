#!/usr/bin/env node
// One-time setup, run from the repo root (or automatically by `npm install`
// at the repo root — see package.json's "postinstall"): points git at
// .githooks/ so the pre-commit privacy guard actually runs. Without this,
// `.githooks/pre-commit` is just an inert file — git only runs hooks from
// `.git/hooks/` or wherever `core.hooksPath` points, and `core.hooksPath`
// is a per-clone local config, not something a repo can ship pre-set.
//
// Cross-platform: `git config` itself handles the path separator
// correctly for whatever OS it's running on, so this just needs to call it
// with a repo-relative path — no shell-specific logic needed here.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const HOOK_PATH = path.join(REPO_ROOT, ".githooks", "pre-commit");

function main() {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: REPO_ROOT, stdio: "inherit" });

  // Windows filesystems don't have a POSIX executable bit, and Git for
  // Windows's bundled sh.exe doesn't require one to run a hook — but on
  // macOS/Linux git silently skips a non-executable hook file with no
  // error, which would make this guard look installed while quietly doing
  // nothing. Set it defensively; chmod is a no-op (doesn't throw) on
  // platforms where it doesn't apply the same way.
  if (existsSync(HOOK_PATH)) {
    try {
      chmodSync(HOOK_PATH, 0o755);
    } catch {
      // Best-effort — not fatal if the filesystem doesn't support it.
    }
  }

  console.log("Git hooks installed: core.hooksPath -> .githooks");
  console.log("Pre-commit will now run scripts/check-privacy.js before every commit.");
}

main();
