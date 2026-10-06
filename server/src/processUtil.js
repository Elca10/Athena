// Cross-platform process spawning used everywhere this app shells out to an
// external CLI (`claude`, `gh`, `git`, `npm`). Two deliberate choices, both
// required by the spec ("no shell-string exec (use argument vectors)"):
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
import spawn from "cross-spawn";

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
export function runCommand(command, args, { timeoutMs = 10_000, cwd, env, input, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env });
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
  return spawn(command, args, { cwd });
}
