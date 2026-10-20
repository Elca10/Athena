// Cross-platform process spawning used everywhere this app shells out to an
// external CLI (`claude`, `gh`, `git`, `npm`). Three deliberate choices:
//
// - `windowsHide: true` on every spawn: this server is started from a
//   hidden shortcut with no console window of its own, so on Windows every
//   child process it spawns would otherwise pop open its own blank console
//   window for the duration of the call (one per button click that shells
//   out) — reported live as "it spawns a claude terminal that's just blank
//   and closes shortly".
//
// - Always pass an argv array, never a single interpolated command string —
//   nothing here is vulnerable to shell injection, even though the args in
//   this codebase are all internally constructed, not raw user input.
// - Use `cross-spawn` instead of `node:child_process.spawn` directly.
//   Node's own `spawn` only reliably finds `.cmd`/`.bat` shims on Windows
//   when `shell: true` is set — but `shell: true` on Windows re-introduces
//   exactly the string-concatenation hazard argv arrays are meant to avoid
//   (args get joined and re-parsed by cmd.exe). `cross-spawn` resolves the
//   right executable (e.g. `gh.cmd`, `claude.cmd` if that's how a given
//   install shows up on Windows) itself while still taking a real argv
//   array. Verified-on-Linux-only here (this machine); flagged as the one
//   Windows-specific risk worth a real smoke test if a bug ever points at a
//   CLI "not found" on a friend's machine.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";

/**
 * Where Claude Code's own Windows installers put `claude` — the native
 * installer (`%USERPROFILE%\.local\bin`), winget's portable-package links
 * dir, and npm's global bin. Each of those installers adds its dir to the
 * *registry* PATH, which a process that was already running at install
 * time (or was started from a terminal opened before it) never sees — so
 * a server started that way reports "Claude Code isn't installed" even
 * after the friend has installed and logged in to it. Uses `path.win32`
 * explicitly, never the ambient `path`, so the result is correct when
 * tested with an injected platform on a non-Windows host.
 */
export function knownWindowsCliDirs({ homedir = os.homedir(), env = process.env } = {}) {
  const dirs = [path.win32.join(homedir, ".local", "bin")];
  const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, "AppData", "Local");
  dirs.push(path.win32.join(localAppData, "Microsoft", "WinGet", "Links"));
  const appData = env.APPDATA || path.win32.join(homedir, "AppData", "Roaming");
  dirs.push(path.win32.join(appData, "npm"));
  return dirs;
}

/**
 * Pure: returns `pathValue` with any of `dirs` that exist (per `existsFn`)
 * and aren't already on it appended at the end — appended, not prepended,
 * so whatever the real PATH already resolves always still wins.
 * Comparison is case-insensitive and ignores a trailing separator, matching
 * how Windows itself treats PATH entries.
 */
export function withExtraPathDirs(pathValue, dirs, { existsFn = existsSync } = {}) {
  const normalize = (p) => p.replace(/[\\/]+$/, "").toLowerCase();
  const entries = (pathValue || "").split(";").filter(Boolean);
  const present = new Set(entries.map(normalize));
  for (const dir of dirs) {
    if (!present.has(normalize(dir)) && existsFn(dir)) {
      entries.push(dir);
      present.add(normalize(dir));
    }
  }
  return entries.join(";");
}

/**
 * On Windows, makes this process's own PATH able to find a `claude`
 * installed after it started (see `knownWindowsCliDirs`). Idempotent and a
 * no-op everywhere else. Mutates `process.env` on purpose: every
 * `runCommand` call that doesn't pass an explicit `env` inherits it, so
 * the setup check and every later `claude -p` turn agree on what's found.
 */
export function ensureKnownCliDirsOnPath({ platform = process.platform } = {}) {
  if (platform !== "win32") return;
  process.env.PATH = withExtraPathDirs(process.env.PATH, knownWindowsCliDirs());
}

/**
 * Runs `command args...` to completion and resolves with
 * `{code, signal, stdout, stderr}` — never rejects on a non-zero exit code
 * (that's a normal, expected outcome for a CLI check, not an error in this
 * process). Only rejects if the child couldn't even be spawned (e.g. the
 * binary genuinely doesn't exist) or if `timeoutMs` elapses first, in which
 * case the child is killed and the promise rejects with a
 * `{ timedOut: true }`-tagged error.
 *
 * `onOutput`, if given, is called with `{stream: "stdout"|"stderr", chunk}`
 * as output arrives — used by the GitHub-connect flow (githubConnect.js) to
 * surface gh's device-code prompt to the UI while the process is still
 * running, not just after it exits.
 */
let modelCallsInFlight = 0;

/** How many `claude -p` model turns are running right now (`/usage` is
 * answered locally and doesn't count). A self-update refuses to start
 * while this is non-zero (updateApply.js), so a Live turn or a content
 * scan is never cut off halfway. */
export function activeModelCalls() {
  return modelCallsInFlight;
}

function isModelCall(command, args) {
  return command === "claude" && args.includes("-p") && !args.includes("/usage");
}

export function runCommand(command, args, options = {}) {
  if (!isModelCall(command, args)) return runCommandInner(command, args, options);
  modelCallsInFlight++;
  return runCommandInner(command, args, options).finally(() => {
    modelCallsInFlight--;
  });
}

function runCommandInner(command, args, { timeoutMs = 10_000, cwd, env, input, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          const err = new Error(`${command} timed out after ${timeoutMs}ms`);
          err.timedOut = true;
          reject(err);
        }, timeoutMs)
      : null;

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // ENOENT here means "not installed" — a real, expected outcome for
      // every caller of this function (checkClaudeCode/checkGh), so it's
      // tagged rather than swallowed, letting callers distinguish "not
      // installed" from "ran and failed".
      err.notFound = err.code === "ENOENT";
      reject(err);
    });

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      onOutput?.({ stream: "stdout", chunk: text });
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      onOutput?.({ stream: "stderr", chunk: text });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin?.end();
  });
}

/** Like `runCommand`, but returns the live child process immediately
 * instead of a promise — for long-running/interactive flows (gh's device
 * login) where the caller needs to poll or cancel mid-flight rather than
 * await completion. Callers are responsible for attaching their own
 * listeners via the returned `child`. */
export function spawnCommand(command, args, { cwd } = {}) {
  return spawn(command, args, { cwd, windowsHide: true });
}

/** The system prompt for every background `claude -p` turn. Each turn's
 * own prompt carries the full task; this just replaces Claude Code's
 * default coding-assistant prompt. */
export const BACKGROUND_SYSTEM_PROMPT =
  "You do one-shot background tasks for a study app. Follow the task exactly, use only the tools you are given, and reply in the format it asks for.";

/**
 * Arguments that keep a background turn small (issue #10): the given
 * model, only the named built-in tools (none if empty), no MCP servers,
 * no skills, and a short system prompt instead of Claude Code's default. Measured on one tiny
 * turn: ~28K tokens of context per model call down to ~3K, and every
 * file read is another call. `--tools` also ignores user/project
 * settings, so a turn behaves the same on every machine.
 */
export function backgroundTurnArgs(tools, { model, effort } = {}) {
  return [
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
    "--tools",
    tools.join(","),
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--system-prompt",
    BACKGROUND_SYSTEM_PROMPT,
  ];
}

// The cheapest model that does each job well (issue #10), rather than
// whatever the user's Claude Code defaults to (often Opus, which uses up
// subscription limits fastest). Aliases, so they follow new releases.
// Measured 2026-10-19 on a 33-slide lecture: Haiku spent ~9K output
// tokens and 61s listing topics that Sonnet listed (slightly better) in
// ~0.7K tokens and 7s, so Haiku isn't cheaper here. Low effort cut a
// 4-topic question turn from ~16K output tokens (2/3 hidden reasoning)
// and 132s to ~5K and 49s, with questions and worked answers still right.
/** Naming the topics a set of slides covers. */
export const TOPIC_MODEL = "sonnet";
export const TOPIC_EFFORT = "low";
/** Writing practice questions, model answers and rubrics. */
export const QUESTION_MODEL = "sonnet";
export const QUESTION_EFFORT = "low";
/** Live mode: asking a question and grading the answer in real time. */
export const LIVE_MODEL = "sonnet";
