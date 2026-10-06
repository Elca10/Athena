import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSubjects, getSubject, createSubject, archiveSubject, restoreSubject } from "../subjects.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-subjects-"));
}

test("listSubjects starts empty", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await listSubjects(dir), []);
});

test("createSubject trims the name and assigns an id, timestamp, and archived:false", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "  Organic Chemistry  " });
  assert.equal(subject.name, "Organic Chemistry");
  assert.equal(subject.archived, false);
  assert.equal(typeof subject.id, "string");
  assert.ok(subject.id.length > 0);
  assert.equal(typeof subject.createdAt, "string");
  assert.deepEqual(await listSubjects(dir), [subject]);
});

test("createSubject rejects a missing or blank name", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => createSubject(dir, {}), /name is required/i);
  await assert.rejects(() => createSubject(dir, { name: "   " }), /name is required/i);
});

test("getSubject returns null for an unknown id", async () => {
  const dir = await scratchDir();
  assert.equal(await getSubject(dir, "no-such-id"), null);
});

test("getSubject finds a subject by id", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "Linear Algebra" });
  assert.deepEqual(await getSubject(dir, subject.id), subject);
});

test("archiveSubject hides a subject from the default list but not includeArchived:true", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "History" });
  const archived = await archiveSubject(dir, subject.id);
  assert.equal(archived.archived, true);
  assert.deepEqual(await listSubjects(dir), []);
  assert.deepEqual(await listSubjects(dir, { includeArchived: true }), [archived]);
});

test("restoreSubject brings an archived subject back into the default list", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "Biology" });
  await archiveSubject(dir, subject.id);
  const restored = await restoreSubject(dir, subject.id);
  assert.equal(restored.archived, false);
  assert.deepEqual(await listSubjects(dir), [restored]);
});

test("archiveSubject on an unknown id throws without corrupting the store", async () => {
  const dir = await scratchDir();
  const subject = await createSubject(dir, { name: "Physics" });
  await assert.rejects(() => archiveSubject(dir, "no-such-id"), /not found/i);
  assert.deepEqual(await listSubjects(dir), [subject]);
});

test("createSubject never collides on id across concurrent creates", async () => {
  const dir = await scratchDir();
  const created = await Promise.all(
    Array.from({ length: 15 }, (_, i) => createSubject(dir, { name: `Subject ${i}` })),
  );
  const ids = new Set(created.map((s) => s.id));
  assert.equal(ids.size, 15);
  assert.equal((await listSubjects(dir)).length, 15);
});
