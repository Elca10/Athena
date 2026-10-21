// Athena's single voice doc (SPEC-v2.md section 5, "Athena's voice"):
// loaded from PERSONA.md once and cached, then included verbatim in every
// model prompt where voice matters — liveSession.js's two prompts
// (the first question, and grading/feedback) and
// questionBankGeneration.js's bank prompt (its modelAnswer/misconceptions
// text is user-visible, surfaced later in Ready mode). One shared loader
// so those callers can't drift on wording, same "one place" reasoning as
// preferencesPrompt.js's `formatPreferencesBlock`.
//
// topicExtraction.js's prompt deliberately gets none — it only ever
// produces short topic labels, not conversational/voiced text (see its
// own module comment and SPEC-v2.md section 5's prompt audit).
//
// Read once per process rather than per call: the file never changes at
// runtime, and re-reading it on every model call would be pure waste.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PERSONA_PATH = path.join(fileURLToPath(new URL(".", import.meta.url)), "PERSONA.md");

let cached = null;

// Strips the leading `# Athena` title — a prompt needs the voice guidance,
// not a repeat of the doc's own heading.
function readPersona() {
  const raw = readFileSync(PERSONA_PATH, "utf8");
  return raw.replace(/^#\s+Athena\s*\n+/, "").trim();
}

/** Athena's voice guidance, ready to drop into a prompt. Cached after the
 * first call. */
export function getPersonaBlock() {
  if (cached === null) cached = readPersona();
  return cached;
}

/** Test-only seam: forces the next `getPersonaBlock()` call to re-read
 * PERSONA.md from disk, so a test that edits/replaces the file doesn't see
 * a stale cache from an earlier test in the same process. */
export function _resetPersonaCacheForTests() {
  cached = null;
}
