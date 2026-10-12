// Shared test helper: puts a fake `claude` executable on PATH that reports
// back what it actually received — the exact argv (minus the leading
// interpreter/script entries) and how many bytes arrived on stdin — instead
// of producing a real (or even plausible) `claude -p` reply. Used only to
// prove the stdin-vs-argv plumbing itself; functions under test still parse
// real `claude -p` replies elsewhere via mocked/injected `runTurn`s, per
// this repo's existing convention (see topicExtraction.test.js's
// `emptyPathEnv` for why a POSIX-only fake success script isn't used there).
//
// Needs a real OS-appropriate executable (not a script relying on a shebang
// line alone) because windows-latest CI can't resolve one: a `.cmd` shim
// that calls out to a plain `.js` file via `node`, versus a POSIX file
// whose shebang points straight at this process's own `node` binary.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const HELPER_BODY = `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdinLength: stdin.length }));
});
`;

/** Resolves to `{ env }`: a copy of the real environment with PATH
 * prepended by a directory containing a fake `claude` that echoes back
 * `{argv, stdinLength}` as its stdout. Pass `env` straight through to the
 * `{env}` option every `run*Turn(prompt, {env})` function already accepts. */
export async function fakeClaudeOnPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-fake-claude-"));
  if (process.platform === "win32") {
    const helperPath = path.join(dir, "fakeClaudeHelper.js");
    await fs.writeFile(helperPath, HELPER_BODY);
    await fs.writeFile(path.join(dir, "claude.cmd"), `@"${process.execPath}" "${helperPath}" %*\r\n`);
  } else {
    const shimPath = path.join(dir, "claude");
    await fs.writeFile(shimPath, `#!${process.execPath}\n${HELPER_BODY}`);
    await fs.chmod(shimPath, 0o755);
  }
  return { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` } };
}
