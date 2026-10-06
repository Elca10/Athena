// "Connect GitHub" step of first-run setup (SPEC.md section 2 step 2 /
// section 10): runs GitHub CLI's own device-code login flow and surfaces
// its output to the browser UI, rather than this app trying to implement
// OAuth itself. `--no-launch-browser` is deliberate: this is a local web
// app, so the right place to show "open this URL and enter this code" is
// Athena's own UI, not a browser window gh tries to pop open server-side.
// Per GitHub's own docs, after the user opens the printed URL and enters
// the code, `gh` polls on its own and the process exits 0 once approved —
// nothing here needs to implement any polling/OAuth logic itself.
//
// State is kept in-memory only (not persisted — a login flow is inherently
// a single browser-session-lifetime thing, and nothing about it is user
// data per section 3 anyway). One flow at a time is enough for a
// single-user local app; starting a new one replaces whatever was running.

import { spawnCommand } from "./processUtil.js";

let current = null; // { id, status, rawOutput, code, verificationUrl, startedAt }

function nextId() {
  return `gh-connect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// gh prints something like:
//   ! First copy your one-time code: ABCD-1234
//   - Press Enter to open github.com in your browser...
//   https://github.com/login/device
// Exact wording has changed across gh versions before and may again, so
// this is a best-effort extraction for a nicer UI — `rawOutput` is always
// shown too, so the flow is never blocked on a regex staying in sync with
// gh's phrasing.
const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_RE = /(https:\/\/github\.com\/login\/device\S*)/;

/** Pure extraction of the one-time code / verification URL from gh's own
 * output, factored out so this regex-matching is unit-testable without
 * spawning a real `gh` process (useful since this dev machine doesn't even
 * have `gh` installed to test against live). Returns `{code, verificationUrl}`,
 * either of which may be `null` if not found yet in the given text. */
export function parseGhLoginOutput(rawOutput) {
  const codeMatch = rawOutput.match(CODE_RE);
  const urlMatch = rawOutput.match(URL_RE);
  return {
    code: codeMatch ? codeMatch[1] : null,
    verificationUrl: urlMatch ? urlMatch[1] : null,
  };
}

function extract(rawOutput, state) {
  const parsed = parseGhLoginOutput(rawOutput);
  if (parsed.code) state.code = parsed.code;
  if (parsed.verificationUrl) state.verificationUrl = parsed.verificationUrl;
}

/** Starts a fresh `gh auth login` flow, killing any previous one still
 * running. Returns the new flow's id immediately; poll
 * `getGithubConnectState(id)` for progress. */
export function startGithubConnect() {
  if (current?.child && current.status === "pending") {
    current.child.kill("SIGKILL");
  }

  const id = nextId();
  const state = {
    id,
    status: "pending", // "pending" | "success" | "error"
    rawOutput: "",
    code: null,
    verificationUrl: null,
    startedAt: Date.now(),
    child: null,
  };
  current = state;

  const child = spawnCommand("gh", [
    "auth",
    "login",
    "--hostname",
    "github.com",
    "--git-protocol",
    "https",
    "--no-launch-browser",
  ]);
  state.child = child;

  const onChunk = (chunk) => {
    state.rawOutput += chunk.toString("utf8");
    extract(state.rawOutput, state);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  child.on("error", (err) => {
    state.status = "error";
    state.rawOutput += `\n[could not start gh: ${err.message}]`;
  });

  child.on("close", (exitCode) => {
    if (state.status === "pending") {
      state.status = exitCode === 0 ? "success" : "error";
    }
  });

  return id;
}

/** Returns the current flow's state, or `null` if none has been started
 * (or `id` doesn't match the current one — e.g. a stale poll after a new
 * flow was started). Never exposes the live `child` handle to callers. */
export function getGithubConnectState(id) {
  if (!current || current.id !== id) return null;
  const { child, ...publicState } = current;
  return publicState;
}
