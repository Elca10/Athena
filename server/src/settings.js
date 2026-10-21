// A small per-user app-settings store — boolean/enum toggles that aren't
// free-text like Tune Athena's preferences (preferences.js) and aren't
// scoped to one subject like subjects.js/bigIdeas.js. First (and so far
// only) setting: whether a study session's end-of-session reflection is
// followed by a short "want to revise your big ideas?" prompt
// (SPEC-v2.md section 3's structure-building row: off by default, the
// user turns it on). One JSON object, not an array — there's no list of
// settings-with-ids the way preferences are a list of entries.

import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";

const FILE_NAME = "settings.json";

// Every known setting's default. Existing installs with no settings.json
// at all (or one missing this key) get the default — no migration needed,
// same "missing field = empty" contract as bigIdeas.js.
const DEFAULTS = {
  bigIdeasPromptEnabled: false,
};

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, {});
}

export async function getSettings(appDataDir) {
  const stored = await storeFor(appDataDir).read();
  return { ...DEFAULTS, ...stored };
}

/** Merges `patch` into the stored settings. Only known keys with the
 * right type are accepted — this is read straight into app behavior
 * (whether a prompt fires), so a typo'd key or a stray string shouldn't
 * silently get stored and then silently do nothing. */
export async function updateSettings(appDataDir, patch = {}) {
  const unknown = Object.keys(patch).filter((key) => !(key in DEFAULTS));
  if (unknown.length) {
    throw new Error(`Unknown setting(s): ${unknown.join(", ")}`);
  }
  if ("bigIdeasPromptEnabled" in patch && typeof patch.bigIdeasPromptEnabled !== "boolean") {
    throw new Error("bigIdeasPromptEnabled must be true or false");
  }

  const stored = await storeFor(appDataDir).update((current) => ({ ...current, ...patch }));
  return { ...DEFAULTS, ...stored };
}
