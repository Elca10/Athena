// Shared test helper: puts a fake `gh` executable on PATH, so every test
// of the bug-report flow can run the real route/module code end to end
// without ever touching the real GitHub CLI or filing a real issue (the
// brief for this build step is explicit: never file a real issue from a
// test). Same cross-platform shape as fakeClaudeOnPath.js in this same
// directory — a real OS-appropriate executable, not a POSIX-only shebang
// script, so this also runs on windows-latest CI.
//
// Dispatches on argv to answer the two `gh` subcommands bugReport.js
// actually calls:
//   - `gh label list ...`   -> a JSON array, `[{name: "bug-report"}]` or
//     `[]`, controlled by `labelExists`.
//   - `gh issue create ...` -> on stdout, the fake issue URL (`url`), or
//     a message on stderr with a non-zero exit code when `mode` isn't
//     "success" — "not-logged-in" and "offline" both produce wording
//     real gh is known to use, so interpretGhIssueCreateResult's own
//     pattern matching is exercised for real, not just assumed.
// Also writes `{argv, stdin}` for the `issue create` call to
// `captureFile` (if given), so a test can assert exactly what was sent —
// the argv array itself, and the full stdin body — without needing gh's
// own stdout to carry that information back.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const HELPER_BODY = `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  const argv = process.argv.slice(2);
  const mode = process.env.FAKE_GH_MODE || "success";
  const captureFile = process.env.FAKE_GH_CAPTURE_FILE;

  if (argv[0] === "label" && argv[1] === "list") {
    const exists = process.env.FAKE_GH_LABEL_EXISTS === "true";
    process.stdout.write(JSON.stringify(exists ? [{ name: "bug-report" }] : []));
    process.exit(0);
  }

  if (argv[0] === "issue" && argv[1] === "create") {
    if (captureFile) {
      require("fs").writeFileSync(captureFile, JSON.stringify({ argv, stdin }));
    }
    if (mode === "success") {
      const url = process.env.FAKE_GH_URL || "https://github.com/Elca10/Athena/issues/123";
      process.stdout.write(url + "\\n");
      process.exit(0);
    }
    if (mode === "not-logged-in") {
      process.stderr.write("You are not logged into any GitHub hosts. Run gh auth login to authenticate.\\n");
      process.exit(1);
    }
    if (mode === "offline") {
      process.stderr.write("error connecting to api.github.com: dial tcp: lookup api.github.com: Temporary failure in name resolution\\n");
      process.exit(1);
    }
    process.stderr.write("some other gh failure\\n");
    process.exit(1);
  }

  process.exit(1);
});
`;

/**
 * Resolves to `{ env }`: a copy of the real environment with PATH
 * prepended by a directory containing the fake `gh` above, plus the
 * FAKE_GH_* env vars this helper's own argv/stdin reads. Pass `env`
 * straight through to the `{env}` option every gh-calling function in
 * bugReport.js already accepts.
 */
export async function fakeGhOnPath({ mode = "success", labelExists = false, url, captureFile } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-fake-gh-"));
  if (process.platform === "win32") {
    const helperPath = path.join(dir, "fakeGhHelper.js");
    await fs.writeFile(helperPath, HELPER_BODY);
    await fs.writeFile(path.join(dir, "gh.cmd"), `@"${process.execPath}" "${helperPath}" %*\r\n`);
  } else {
    const shimPath = path.join(dir, "gh");
    await fs.writeFile(shimPath, `#!${process.execPath}\n${HELPER_BODY}`);
    await fs.chmod(shimPath, 0o755);
  }

  return {
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_GH_MODE: mode,
      FAKE_GH_LABEL_EXISTS: String(labelExists),
      ...(url ? { FAKE_GH_URL: url } : {}),
      ...(captureFile ? { FAKE_GH_CAPTURE_FILE: captureFile } : {}),
    },
  };
}
