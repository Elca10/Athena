// Subjects: the top-level unit a user studies (SPEC.md section 4's
// subject cards; section 7's content-ingestion target; section 9's
// per-subject deadlines). This module is only the data model — list,
// create, archive, restore. Content ingestion and topic extraction read
// and write against a subject's `id` but are their own build-13-step-2
// sub-steps, not part of this one.
//
// Archiving never deletes data (section 4: "Archiving a subject keeps its
// data; it just leaves the dashboard and the schedule") — it's a boolean
// flag, filtered out of the default list view.

import { randomUUID } from "node:crypto";
import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";

const FILE_NAME = "subjects.json";

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, []);
}

export async function listSubjects(appDataDir, { includeArchived = false } = {}) {
  const subjects = await storeFor(appDataDir).read();
  return includeArchived ? subjects : subjects.filter((s) => !s.archived);
}

export async function getSubject(appDataDir, id) {
  const subjects = await storeFor(appDataDir).read();
  return subjects.find((s) => s.id === id) ?? null;
}

export async function createSubject(appDataDir, { name }) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new Error("Subject name is required");

  const subject = {
    id: randomUUID(),
    name: trimmed,
    archived: false,
    createdAt: new Date().toISOString(),
  };
  await storeFor(appDataDir).update((current) => [...current, subject]);
  return subject;
}

async function setArchived(appDataDir, id, archived) {
  const subjects = await storeFor(appDataDir).update((current) => {
    const idx = current.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Subject not found: ${id}`);
    const next = current.slice();
    next[idx] = { ...next[idx], archived };
    return next;
  });
  return subjects.find((s) => s.id === id);
}

export function archiveSubject(appDataDir, id) {
  return setArchived(appDataDir, id, true);
}

export function restoreSubject(appDataDir, id) {
  return setArchived(appDataDir, id, false);
}
