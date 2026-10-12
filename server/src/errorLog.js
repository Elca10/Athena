// A small in-memory ring buffer of recent server-side error lines, used
// only as one of the automatic diagnostics attached to a bug report
// (SPEC.md section 10/3.6): "app version/commit, OS + version, and recent
// server error log lines." Deliberately in-memory, not a log file — this
// app has never written one, and standing up file logging (rotation,
// app-data-dir placement, redaction-on-write) is out of scope for this
// step. In-memory means the buffer only covers errors since the server's
// last start, which is the right scope anyway: a bug report is about
// "what's wrong right now," not historical archaeology.
//
// Capped well below anything that could matter for memory use on a
// single-user local app; each entry is a short string, never the
// description/content text the rest of the app handles.

const MAX_ENTRIES = 50;
const entries = [];

/** Records one error line (already stringified — this module doesn't
 * know or care about Error objects, stack traces, etc.; callers decide
 * what's worth keeping). Oldest entries drop off once the buffer is full. */
export function recordError(message) {
  const line = `${new Date().toISOString()} ${String(message)}`;
  entries.push(line);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/** Returns up to `limit` of the most recent recorded lines, oldest first —
 * matching how a log tail is normally read. */
export function getRecentErrorLines(limit = 20) {
  return entries.slice(-limit);
}

/** Test-only: clears the buffer so one test's errors can't leak into another. */
export function clearRecentErrors() {
  entries.length = 0;
}
