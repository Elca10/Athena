// Tune Athena (SPEC.md section 8): plain-language study preferences the
// user writes ("harder questions on proofs", "always give me a worked
// example after a miss"). Stored verbatim as per-user preferences in the
// app-data dir and, in a later step, included in the prompts that
// generate questions/feedback — this module is only the data model: list,
// add, delete. There is no model turn here to interpret or apply the
// text: the spec is explicit that these "never edit the shared persona,
// code, or repo", so storing the raw text is the whole job.

import { randomUUID } from "node:crypto";
import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";

const FILE_NAME = "preferences.json";

// A preference is a short standing instruction, not a document — and
// every one of them gets repeated into prompts later, so both caps keep
// that future prompt bounded rather than letting it grow unboundedly.
const MAX_TEXT_CHARS = 500;
const MAX_PREFERENCES = 50;

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, []);
}

export async function listPreferences(appDataDir) {
  return storeFor(appDataDir).read();
}

export async function addPreference(appDataDir, { text }) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) throw new Error("Preference text is required");
  if (trimmed.length > MAX_TEXT_CHARS) {
    throw new Error(`Preference text is too long (limit is ${MAX_TEXT_CHARS} characters)`);
  }

  const preference = {
    id: randomUUID(),
    text: trimmed,
    createdAt: new Date().toISOString(),
  };
  await storeFor(appDataDir).update((current) => {
    if (current.length >= MAX_PREFERENCES) {
      throw new Error(`Already at the maximum of ${MAX_PREFERENCES} preferences`);
    }
    return [...current, preference];
  });
  return preference;
}

export async function deletePreference(appDataDir, id) {
  await storeFor(appDataDir).update((current) => {
    if (!current.some((p) => p.id === id)) throw new Error(`Preference not found: ${id}`);
    return current.filter((p) => p.id !== id);
  });
}
