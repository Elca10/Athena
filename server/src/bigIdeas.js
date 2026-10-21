// Per-subject "big ideas" summary (SPEC.md section 6: "Structure building /
// mental models — per subject, a living 'big ideas' summary the user
// builds and revises"; SPEC-v2.md section 3's structure-building row,
// made optional). The whole point (Make It Stick) is that the USER writes
// and revises this themselves — there is no model call anywhere in this
// module, not even to tidy wording. It's just a data model: read, write,
// and a short revision history so a bad edit can be undone (restoring a
// past version is just writing it again — see routes/bigIdeas.js, which
// is the only thing that calls `setBigIdeas`).
//
// One record per subject (keyed by `subjectId`), same array-of-records
// shape as subjects.js/preferences.js rather than one-file-per-subject —
// consistent with every other store in this codebase, and there's no
// reason a subject's big ideas would ever be read without the rest of
// this small file being read anyway.

import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";

const FILE_NAME = "big-ideas.json";

// A summary is meant to be a handful of sentences a user can actually
// revise in a sitting, not a document — keeps the subject detail view's
// section (and the post-session prompt's compact editor) bounded.
export const MAX_BIG_IDEAS_CHARS = 4000;

// "Keep a short revision history (e.g. last 10 versions)" — the spec's own
// number; nothing here depends on it being exactly 10.
export const MAX_HISTORY_VERSIONS = 10;

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, []);
}

function emptyRecord(subjectId) {
  return { subjectId, text: "", updatedAt: null, history: [] };
}

/** Never throws on a subject with nothing saved yet — that's just the
 * empty record, not an error (existing installs with no `big-ideas.json`
 * at all get this for every subject, which is the "missing field = empty,
 * no migration" contract SPEC-v2.md asks for). */
export async function getBigIdeas(appDataDir, subjectId) {
  const all = await storeFor(appDataDir).read();
  return all.find((r) => r.subjectId === subjectId) ?? emptyRecord(subjectId);
}

function cleanText(text) {
  return typeof text === "string" ? text.trim() : "";
}

/**
 * Overwrites a subject's big ideas text. The previous text (if any, and if
 * actually different) is pushed onto `history` first, oldest dropped past
 * `MAX_HISTORY_VERSIONS` — so "restoring" a past version is just calling
 * this again with that version's text (routes/bigIdeas.js exposes no
 * separate restore endpoint; the web client's history list just re-submits
 * the old text through this same PUT, which is itself trackable as a
 * normal edit — nothing is silently lost either way). Saving an empty
 * string is allowed (clearing it out is a legitimate edit, not an error).
 */
export async function setBigIdeas(appDataDir, subjectId, text) {
  const cleaned = cleanText(text);
  if (cleaned.length > MAX_BIG_IDEAS_CHARS) {
    throw new Error(`Big ideas text is too long (limit is ${MAX_BIG_IDEAS_CHARS} characters)`);
  }

  const updatedAt = new Date().toISOString();
  const updated = await storeFor(appDataDir).update((current) => {
    const idx = current.findIndex((r) => r.subjectId === subjectId);
    const existing = idx === -1 ? emptyRecord(subjectId) : current[idx];
    const history =
      existing.text && existing.text !== cleaned
        ? [...existing.history, { text: existing.text, updatedAt: existing.updatedAt }].slice(-MAX_HISTORY_VERSIONS)
        : existing.history;
    const next = { subjectId, text: cleaned, updatedAt, history };
    if (idx === -1) return [...current, next];
    const copy = current.slice();
    copy[idx] = next;
    return copy;
  });
  return updated.find((r) => r.subjectId === subjectId);
}
