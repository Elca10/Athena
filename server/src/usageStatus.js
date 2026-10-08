// Subscription usage for the top bar (SPEC.md section 4/13's priority
// queue item 1): how much of the account's Claude usage windows have been
// used, read straight from the `claude` CLI's own built-in `/usage` slash
// command rather than guessed at or derived from this app's own model
// calls. `/usage` is answered locally off the CLI's own account-status
// fetch -- it never touches the inference API (confirmed elsewhere:
// `total_cost_usd: 0`, no real turn round-trips) -- so checking it live on
// every top-bar load is free, not something that needs polling/caching to
// stay cheap. `/status` (the richer interactive view) was confirmed
// elsewhere NOT to work in `-p` mode; `/usage` is the one built-in that
// works headlessly.
//
// Unlike a comparable integration elsewhere (which also passively
// captured a *partial* per-turn signal reporting one window at a time, and
// so had to merge partial updates into a shared cache without one
// overwriting the other), this module only ever has one source: a direct
// `/usage` call, which always states both windows in the one reply. So
// there's no partial-update merge to get wrong here -- each check simply
// replaces the whole cached reading.

import { runCommand } from "./processUtil.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";
import { appDataSubdirs } from "./dataDir.js";

// `/usage` is answered locally with no inference round-trip, so this only
// needs to bound a hung CLI process, not a slow model turn.
const TURN_TIMEOUT_MS = 15_000;

// Matches "Current session: 27% used · resets Aug 24 at 5pm (America/..."
// and "Current week (all models): 20% used · resets Aug 30 at 12:59am
// (America/...". Deliberately doesn't anchor on the "·" separator between
// "used" and "resets" so minor spacing/punctuation drift in a future CLI
// version doesn't silently break this. "Current week (all models)"
// specifically (not just "Current week") since the real reply can list a
// per-model "Current week (Opus)" line too -- this only ever wants the
// general, all-models figure.
const USAGE_TEXT_PATTERNS = {
  fiveHour: /Current session:\s*(\d+)%\s*used.*?resets\s+([^\n(]+)\(/i,
  weekly: /Current week \(all models\):\s*(\d+)%\s*used.*?resets\s+([^\n(]+)\(/i,
};

const MONTH_ABBREVIATIONS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parses a reset-time fragment like "Aug 24 at 5pm" or "Aug 30 at
 * 12:59am" -- or the CLI's newer comma form, "Oct 4, 12:59am" -- (captured
 * with the trailing "(<timezone>)" already stripped by the caller's regex)
 * into unix seconds. No explicit timezone math: the CLI reports this in
 * whatever zone the local machine is set to, and this server always runs
 * on that same machine, so building the Date in the server process's own
 * local time is correct. Returns `undefined` (not throwing) on anything
 * that doesn't match the expected shape, so a future CLI wording change
 * degrades to "no resetsAt" rather than crashing the whole check. */
export function parseResetsAt(text, now = Date.now()) {
  const m = text
    .trim()
    .match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:\s*,|\s+at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return undefined;
  const [, monAbbr, day, hourStr, minStr, ampm] = m;
  const month = MONTH_ABBREVIATIONS.indexOf(monAbbr.toLowerCase());
  if (month === -1) return undefined;
  let hour = Number(hourStr) % 12;
  if (ampm.toLowerCase() === "pm") hour += 12;
  const minute = minStr ? Number(minStr) : 0;
  const year = new Date(now).getFullYear();
  let candidate = new Date(year, month, Number(day), hour, minute, 0, 0);
  // A reset is always near-future relative to when it was reported. If
  // building with the current year lands more than a couple days in the
  // past, the real date must be next year (e.g. checking Dec 31 for a
  // "Jan 2" reset) -- a generous slop rather than "> now" so a reading a
  // few minutes stale doesn't misfire this.
  if (candidate.getTime() < now - 2 * 24 * 60 * 60 * 1000) {
    candidate = new Date(year + 1, month, Number(day), hour, minute, 0, 0);
  }
  return Math.floor(candidate.getTime() / 1000);
}

function deriveStatus(utilization) {
  if (utilization >= 1) return "exceeded";
  if (utilization >= 0.9) return "warning";
  return "ok";
}

/** Turns `/usage`'s plain-text reply into `{fiveHour, weekly}`, each either
 * `{status, utilization, resetsAt?}` or `null` if that window's line wasn't
 * found in the reply at all (an unexpected reply shape -- e.g. the CLI
 * changes `/usage`'s wording -- not an expected steady-state outcome).
 * Pure and exported so it's directly unit-testable against real captured
 * `/usage` output without spawning a process. */
export function parseUsageCommandText(text, now = Date.now()) {
  const parseWindow = (regex) => {
    const m = text.match(regex);
    if (!m) return null;
    const utilization = Number(m[1]) / 100;
    const resetsAt = parseResetsAt(m[2], now);
    return { status: deriveStatus(utilization), utilization, ...(resetsAt !== undefined && { resetsAt }) };
  };
  return { fiveHour: parseWindow(USAGE_TEXT_PATTERNS.fiveHour), weekly: parseWindow(USAGE_TEXT_PATTERNS.weekly) };
}

/**
 * Fires `claude -p -- "/usage"` and returns its raw stdout. `/usage` is a
 * CLI-native slash command, not a message to a persona, so it's sent as
 * literal text with no wrapping. `env` is a test seam matching
 * topicExtraction.js's `runExtractionTurn({env})` convention: passed
 * straight to `runCommand`, defaulting to the full inherited environment
 * but overridable to a scratch PATH so this function's own test can prove
 * the "claude not found" path deterministically without needing a fake
 * executable for the success path.
 */
export async function runUsageCheckTurn({ env } = {}) {
  const result = await runCommand("claude", ["-p", "--", "/usage"], { timeoutMs: TURN_TIMEOUT_MS, env });
  if (result.code !== 0) {
    throw new Error(`claude exited with code ${result.code}: ${result.stderr.slice(0, 300)}`);
  }
  return result.stdout;
}

function store(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, "usage-status.json", {
    fiveHour: null,
    weekly: null,
    checkedAt: null,
    error: null,
  });
}

/** The last-known reading, free (no CLI call) -- what a page load can show
 * before `checkUsageNow`'s own fresh check resolves. */
export async function getCachedUsageStatus(appDataDir) {
  return store(appDataDir).read();
}

/**
 * Runs a fresh `/usage` check and persists the result. Never throws: a
 * CLI failure or an unparseable reply is a real, recoverable outcome (the
 * CLI might not be installed/logged in, or a future version might reword
 * its reply), not a request error -- it's recorded as `{..., error:
 * "..."}` with both windows left `null` so the caller can show "couldn't
 * check" rather than stale numbers presented as fresh. `runTurn` is the DI
 * seam every test but `runUsageCheckTurn`'s own uses -- no test here ever
 * shells out to the real CLI (see this module's own `__tests__`).
 */
export async function checkUsageNow(appDataDir, { runTurn = runUsageCheckTurn } = {}) {
  let text;
  try {
    text = await runTurn();
  } catch (err) {
    const result = { fiveHour: null, weekly: null, checkedAt: Date.now(), error: String(err.message ?? err).slice(0, 300) };
    await store(appDataDir).write(result);
    return result;
  }

  const parsed = parseUsageCommandText(text);
  if (!parsed.fiveHour && !parsed.weekly) {
    const result = {
      fiveHour: null,
      weekly: null,
      checkedAt: Date.now(),
      error: "Couldn't parse /usage output -- the CLI's reply shape may have changed.",
    };
    await store(appDataDir).write(result);
    return result;
  }

  const result = { ...parsed, checkedAt: Date.now(), error: null };
  await store(appDataDir).write(result);
  return result;
}
