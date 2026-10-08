import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPreferences, addPreference, deletePreference } from "../preferences.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-preferences-"));
}

test("listPreferences starts empty", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await listPreferences(dir), []);
});

test("addPreference trims the text and assigns an id and timestamp", async () => {
  const dir = await scratchDir();
  const preference = await addPreference(dir, { text: "  harder questions on proofs  " });
  assert.equal(preference.text, "harder questions on proofs");
  assert.equal(typeof preference.id, "string");
  assert.ok(preference.id.length > 0);
  assert.equal(typeof preference.createdAt, "string");
  assert.deepEqual(await listPreferences(dir), [preference]);
});

test("addPreference rejects a missing or blank text", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => addPreference(dir, {}), /text is required/i);
  await assert.rejects(() => addPreference(dir, { text: "   " }), /text is required/i);
});

test("addPreference rejects text over the length limit", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => addPreference(dir, { text: "x".repeat(501) }), /too long/i);
  assert.deepEqual(await listPreferences(dir), []);
});

test("addPreference rejects a 51st preference without corrupting the store", async () => {
  const dir = await scratchDir();
  for (let i = 0; i < 50; i++) {
    await addPreference(dir, { text: `preference ${i}` });
  }
  await assert.rejects(() => addPreference(dir, { text: "one too many" }), /maximum of 50/i);
  assert.equal((await listPreferences(dir)).length, 50);
});

test("deletePreference removes exactly the matching entry", async () => {
  const dir = await scratchDir();
  const first = await addPreference(dir, { text: "first" });
  const second = await addPreference(dir, { text: "second" });
  await deletePreference(dir, first.id);
  assert.deepEqual(await listPreferences(dir), [second]);
});

test("deletePreference on an unknown id throws without corrupting the store", async () => {
  const dir = await scratchDir();
  const preference = await addPreference(dir, { text: "keep me" });
  await assert.rejects(() => deletePreference(dir, "no-such-id"), /not found/i);
  assert.deepEqual(await listPreferences(dir), [preference]);
});

test("addPreference never collides on id across concurrent adds", async () => {
  const dir = await scratchDir();
  const created = await Promise.all(
    Array.from({ length: 15 }, (_, i) => addPreference(dir, { text: `preference ${i}` })),
  );
  const ids = new Set(created.map((p) => p.id));
  assert.equal(ids.size, 15);
  assert.equal((await listPreferences(dir)).length, 15);
});
