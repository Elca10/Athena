// Redaction for anything that might end up in a public GitHub issue
// (SPEC.md section 3: "GitHub issues are redacted... paths/usernames
// scrubbed... never course content, question text, answers, or study
// history"). Used on both the user's free-text bug description AND the
// automatically-collected diagnostics (recent error log lines can easily
// contain a home-directory path from a stack trace).
//
// Deliberately pure and dependency-free (no fs/os calls) so it's trivial
// to test exhaustively — callers pass in whatever OS-specific or
// app-specific values need scrubbing (home dir, username, subject/topic
// names) rather than this module reaching out to get them itself.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// POSIX home dirs: /home/<user>/... or /Users/<user>/... — keeps the
// "/home/" or "/Users/" prefix (so the redacted text still reads as a
// path) but blanks out the one path segment that's actually personal.
const POSIX_HOME_RE = /\/(home|Users)\/([^/\s]+)/g;

// Windows home dirs: C:\Users\<user>\... — any drive letter, and either
// slash direction since text pasted from different tools varies.
const WINDOWS_HOME_RE = /([A-Za-z]:[\\/]Users[\\/])([^\\/\s]+)/g;

// A calendar-feed link (canvasFeed.js) is a secret: anyone holding it can
// read the user's Canvas calendar. Matched by shape, so it's caught even
// in text the user typed or pasted themselves.
const CALENDAR_FEED_RE = /(?:https?|webcal):\/\/[^\s"'<>]*\/feeds\/calendars\/[^\s"'<>]+/gi;

function redactPaths(text) {
  return text.replace(POSIX_HOME_RE, (_m, prefix) => `/${prefix}/<user>`).replace(WINDOWS_HOME_RE, (_m, prefix) => `${prefix}<user>`);
}

function redactEmails(text) {
  return text.replace(EMAIL_RE, "<email>");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Redacts a list of known literal strings (OS username, home dir, actual
// subject/topic names) wherever they appear — longest first, so a shorter
// name that happens to be a substring of a longer one (e.g. "CSC" inside
// "CSC4553") never partially shadows the longer match first.
function redactLiterals(text, literals, placeholder) {
  const sorted = [...new Set(literals.filter(Boolean))].sort((a, b) => b.length - a.length);
  let result = text;
  for (const literal of sorted) {
    const re = new RegExp(escapeRegExp(literal), "gi");
    result = result.replace(re, placeholder);
  }
  return result;
}

/**
 * Redacts `text` for inclusion in a public GitHub issue. Order:
 * 0. calendar-feed links, whole (before paths, which would only blank
 *    part of one).
 * 1. home-directory paths (POSIX and Windows forms).
 * 2. email addresses — must come before extraLiterals below: an OS
 *    username is very often also the local part of the user's email
 *    (`sarah@example.com`), so redacting that literal first would eat
 *    only "sarah" and leave a mangled "<redacted>@example.com" instead of
 *    a clean "<email>".
 * 3. extraLiterals (OS username/home dir passed in by the caller) —
 *    whatever's left after paths/emails have already claimed their own
 *    occurrences.
 * 4. known subject names, then known topic names — the user's own study
 *    material/organization, never meant to leave their machine.
 * Never throws — called on both user-typed text and raw log lines, which
 * this function must treat as untrusted, arbitrary strings.
 */
export function redactText(text, { subjectNames = [], topicNames = [], extraLiterals = [] } = {}) {
  let result = String(text ?? "");
  result = result.replace(CALENDAR_FEED_RE, "<calendar-feed>");
  result = redactPaths(result);
  result = redactEmails(result);
  result = redactLiterals(result, extraLiterals, "<redacted>");
  result = redactLiterals(result, subjectNames, "<subject>");
  result = redactLiterals(result, topicNames, "<topic>");
  return result;
}
