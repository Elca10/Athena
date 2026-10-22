// Canvas calendar-feed import (SPEC-v2.md section 2's calendar decisions).
// The user pastes their private Canvas calendar-feed URL once; Athena
// fetches the ICS file itself and parses it in plain code (no model
// calls), then the user ticks which upcoming events to study for and
// picks the subject. Ticked events become ordinary deadlines
// (deadlines.js) with `source: "canvas"` and the event's UID as
// `externalId`, so the same event is never imported twice.
//
// The feed URL is a secret (anyone holding it can read the user's Canvas
// calendar): it lives only in the data dir (canvas-feed.json), is never
// sent back to the browser (status reports the host only), and never
// appears in an error message, since error messages can reach the error
// log and from there a bug report. redact.js scrubs feed URLs from bug
// reports as a second line of defense. This is the only network call
// Athena makes outside the user's Claude account and GitHub.
//
// The user's decisions win: a Canvas event whose date or title changed
// after import is only flagged (`changed`), never rewritten here. The UI
// offers an Update button that goes through the ordinary deadline PATCH.

import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";
import { createDeadline, listAllDeadlines, MAX_DEADLINE_TITLE_LENGTH } from "./deadlines.js";
import { localDateOf } from "./localDate.js";
import { getSubject, listSubjects } from "./subjects.js";

const FILE_NAME = "canvas-feed.json";

export const MAX_FEED_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** An error whose message is safe to show the user and to log: it never
 *  contains the feed URL. Routes turn it into a 4xx/502. */
export class FeedError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, {});
}

/**
 * Normalizes a pasted feed URL, or throws a FeedError. Canvas feed URLs
 * look like https://<school>/feeds/calendars/user_<token>.ics; requiring
 * that shape (and https) keeps the server from being pointed at anything
 * else, a local address included.
 */
export function validateFeedUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  // Calendar apps hand these out as webcal://, which is the same URL over https.
  const candidate = text.replace(/^webcal:\/\//i, "https://");
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new FeedError("That doesn't look like a link. Copy the Calendar Feed link from Canvas and paste it here.");
  }
  if (url.protocol !== "https:" || url.username || url.password || !/^\/feeds\/calendars\/[^/]+\.ics$/i.test(url.pathname)) {
    throw new FeedError(
      "That isn't a Canvas calendar feed link. In Canvas, open Calendar, click Calendar Feed, and copy the link it shows (it ends in .ics).",
    );
  }
  url.hash = "";
  return url.toString();
}

async function readCapped(res) {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FEED_BYTES) {
      await reader.cancel().catch(() => {});
      throw new FeedError("That calendar feed is too big to import.", 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Fetches the feed's text. `fetchImpl` is injectable for tests. */
export async function fetchFeedText(url, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      redirect: "follow",
      headers: { Accept: "text/calendar" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new FeedError("Couldn't reach Canvas. Check your internet connection, then try again.", 502);
  }
  if (res.url && !res.url.startsWith("https:")) {
    throw new FeedError("Canvas redirected the feed somewhere insecure, so Athena stopped.", 502);
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new FeedError(
      "Canvas didn't recognize that feed link. It may have been reset: copy it again from Canvas's Calendar Feed.",
      502,
    );
  }
  if (!res.ok) throw new FeedError(`Canvas answered with an error (HTTP ${res.status}). Try again later.`, 502);
  let text;
  try {
    text = await readCapped(res);
  } catch (err) {
    if (err instanceof FeedError) throw err;
    throw new FeedError("Couldn't finish downloading the calendar feed. Try again.", 502);
  }
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new FeedError("That link didn't return a calendar. Copy the Calendar Feed link from Canvas again.", 502);
  }
  return text;
}

// RFC 5545 TEXT escapes. A line break inside a title becomes a space.
function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_m, c) => (c === "n" || c === "N" ? " " : c));
}

// Splits "NAME;PARAM=a;PARAM2=\"x:y\":value" at the first colon that
// isn't inside a quoted parameter value.
function splitProperty(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      const [name, ...params] = line.slice(0, i).split(";");
      return { name: name.toUpperCase(), params: params.map((p) => p.toUpperCase()), value: line.slice(i + 1) };
    }
  }
  return null;
}

// DTSTART as a local calendar date. A UTC time ("...Z") is converted to
// the user's own zone (a Canvas assignment due 11:59pm Eastern arrives as
// 03:59Z the next day); a date-only or zoned/floating time is taken at
// its written date.
function eventDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return localDateOf(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0))));
  return `${y}-${mo}-${d}`;
}

// Canvas titles end in the course, e.g. "Homework 3 [CSC 4553 - Spring]".
function splitCourse(summary) {
  const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(summary);
  return m && m[1] ? { title: m[1], course: m[2].trim() } : { title: summary, course: null };
}

/** Every VEVENT with a UID and a usable start date: {uid, title, course, date}. */
export function parseIcs(text) {
  const lines = String(text).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    const prop = splitProperty(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") current = {};
    else if (prop.name === "END" && prop.value.toUpperCase() === "VEVENT") {
      if (current?.uid && current.date) {
        const { title, course } = splitCourse(current.summary ?? "");
        const clean = title.trim().replace(/\s+/g, " ").slice(0, MAX_DEADLINE_TITLE_LENGTH) || "Untitled Canvas event";
        events.push({ uid: current.uid, title: clean, course, date: current.date });
      }
      current = null;
    } else if (current) {
      if (prop.name === "UID") current.uid = prop.value.trim();
      else if (prop.name === "SUMMARY") current.summary = unescapeText(prop.value);
      else if (prop.name === "DTSTART") current.date = eventDate(prop.value);
    }
  }
  return events;
}

function normalizeName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The one subject whose name appears in the event's course, or null when
 *  none or several do (a guess the user can change, never a silent pick). */
export function suggestSubjectId(course, subjects) {
  if (!course) return null;
  const c = normalizeName(course);
  const matches = subjects.filter((s) => {
    const n = normalizeName(s.name);
    return n.length >= 3 && (c.includes(n) || n.includes(c));
  });
  return matches.length === 1 ? matches[0].id : null;
}

async function readStoredUrl(appDataDir) {
  const stored = await storeFor(appDataDir).read();
  return typeof stored.url === "string" ? stored.url : null;
}

async function requireStoredUrl(appDataDir) {
  const url = await readStoredUrl(appDataDir);
  if (!url) throw new FeedError("Connect your Canvas calendar feed first.", 409);
  return url;
}

/** {connected, host}: the host only, never the secret URL itself. */
export async function getFeedStatus(appDataDir) {
  const url = await readStoredUrl(appDataDir);
  return url ? { connected: true, host: new URL(url).host } : { connected: false, host: null };
}

/** Validates the URL, checks it really returns a calendar, then stores it. */
export async function saveFeedUrl(appDataDir, raw, { fetchImpl } = {}) {
  const url = validateFeedUrl(raw);
  parseIcs(await fetchFeedText(url, { fetchImpl }));
  await storeFor(appDataDir).update((current) => ({ ...current, url, savedAt: new Date().toISOString() }));
  return getFeedStatus(appDataDir);
}

export async function forgetFeed(appDataDir) {
  await storeFor(appDataDir).update(() => ({}));
}

/**
 * Upcoming feed events (today or later, soonest first), each with the
 * deadline it was already imported as (or null), whether that deadline
 * now differs from Canvas, and a suggested subject for new ones.
 */
export async function listFeedEvents(appDataDir, { today = localDateOf(), fetchImpl } = {}) {
  const url = await requireStoredUrl(appDataDir);
  const events = parseIcs(await fetchFeedText(url, { fetchImpl }));
  const subjects = await listSubjects(appDataDir);
  const byExternalId = new Map(
    (await listAllDeadlines(appDataDir)).filter((d) => d.source === "canvas" && d.externalId).map((d) => [d.externalId, d]),
  );
  const unique = [...new Map(events.map((e) => [e.uid, e])).values()];
  return unique
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
    .map((e) => {
      const existing = byExternalId.get(e.uid);
      const imported = existing
        ? { deadlineId: existing.id, subjectId: existing.subjectId, title: existing.title, date: existing.date }
        : null;
      return {
        ...e,
        imported,
        changed: Boolean(imported && (imported.date !== e.date || imported.title !== e.title)),
        suggestedSubjectId: imported ? null : suggestSubjectId(e.course, subjects),
      };
    });
}

/**
 * Imports the chosen events into one subject. Titles and dates come from
 * a fresh fetch of the feed, not the browser, so only real feed events
 * can be imported. Events already imported (anywhere) are skipped.
 * Returns {added: Deadline[], skipped: number}.
 */
export async function importFeedEvents(appDataDir, { subjectId, uids }, { fetchImpl } = {}) {
  if (!Array.isArray(uids) || uids.length === 0 || uids.some((u) => typeof u !== "string")) {
    throw new FeedError("Tick at least one event to add.");
  }
  if (typeof subjectId !== "string" || !(await getSubject(appDataDir, subjectId))) {
    throw new FeedError("Pick which subject these are for.");
  }
  const url = await requireStoredUrl(appDataDir);
  const byUid = new Map(parseIcs(await fetchFeedText(url, { fetchImpl })).map((e) => [e.uid, e]));
  const already = new Set((await listAllDeadlines(appDataDir)).map((d) => d.externalId).filter(Boolean));
  const added = [];
  let skipped = 0;
  for (const uid of new Set(uids)) {
    const event = byUid.get(uid);
    if (!event || already.has(uid)) {
      skipped += 1;
      continue;
    }
    added.push(
      await createDeadline(appDataDir, subjectId, { title: event.title, date: event.date, studying: true }, { source: "canvas", externalId: uid }),
    );
  }
  return { added, skipped };
}
