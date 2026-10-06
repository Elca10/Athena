import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeJsonFileStore, __setBackupThrottleForTests } from "../jsonFileStore.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-jsonfilestore-"));
}

test("read() returns a fresh copy of defaultValue when the file doesn't exist yet", async () => {
  const dir = await scratchDir();
  const store = makeJsonFileStore(dir, "thing.json", []);
  const first = await store.read();
  first.push("mutated");
  const second = await store.read();
  assert.deepEqual(second, []);
});

test("write() then read() round-trips", async () => {
  const dir = await scratchDir();
  const store = makeJsonFileStore(dir, "thing.json", []);
  await store.write([{ id: "a" }]);
  assert.deepEqual(await store.read(), [{ id: "a" }]);
});

test("write() leaves no stray .tmp files behind", async () => {
  const dir = await scratchDir();
  const store = makeJsonFileStore(dir, "thing.json", []);
  await store.write([{ id: "a" }]);
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries.filter((e) => e.endsWith(".tmp")), []);
});

test("update() is race-free: many concurrent appends all land", async () => {
  const dir = await scratchDir();
  const store = makeJsonFileStore(dir, "thing.json", []);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.update((current) => [...current, i])),
  );
  const final = await store.read();
  assert.equal(final.length, 20);
  assert.deepEqual([...final].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
});

test("update()'s mutator sees the value its own write just committed, not a stale one", async () => {
  const dir = await scratchDir();
  const store = makeJsonFileStore(dir, "thing.json", { count: 0 });
  await Promise.all(Array.from({ length: 10 }, () => store.update((cur) => ({ count: cur.count + 1 }))));
  assert.deepEqual(await store.read(), { count: 10 });
});

test("backupBeforeOverwrite snapshots the prior valid content before a write replaces it", async () => {
  __setBackupThrottleForTests(0);
  const dir = await scratchDir();
  const store = makeJsonFileStore(dir, "thing.json", []);
  await store.write([{ id: "good" }]);
  await store.write([]); // a write that (deliberately, for this test) looks like data loss
  const backupDir = path.join(dir, "backups");
  const backups = await fs.readdir(backupDir);
  assert.equal(backups.length, 1);
  const content = await fs.readFile(path.join(backupDir, backups[0]), "utf8");
  assert.deepEqual(JSON.parse(content), [{ id: "good" }]);
});

test("backupBeforeOverwrite never backs up a missing or empty prior file", async () => {
  __setBackupThrottleForTests(0);
  const dir = await scratchDir();
  const store = makeJsonFileStore(dir, "thing.json", []);
  await store.write([{ id: "first write, nothing on disk before it" }]);
  const backupDir = path.join(dir, "backups");
  await assert.rejects(() => fs.readdir(backupDir), { code: "ENOENT" });
});

test("backupBeforeOverwrite prunes to at most 20 backups per file", async () => {
  // Backup filenames are timestamp-keyed (ms resolution): writes fast
  // enough to land in the same millisecond can share a filename and
  // collapse two backups into one, so the honest assertion is "never
  // more than the cap," not "always exactly the cap".
  __setBackupThrottleForTests(0);
  const dir = await scratchDir();
  const store = makeJsonFileStore(dir, "thing.json", []);
  for (let i = 0; i < 25; i++) {
    await store.write([i]);
  }
  const backupDir = path.join(dir, "backups");
  const backups = await fs.readdir(backupDir);
  assert.ok(backups.length <= 20, `expected pruning to cap backups at 20, got ${backups.length}`);
});
