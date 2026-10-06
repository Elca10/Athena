import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listContent, addUploadedContent, addPastedNotes } from "../content.js";
import { appDataSubdirs } from "../dataDir.js";
import { makeJsonFileStore } from "../store/jsonFileStore.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-content-"));
}

test("listContent starts empty for any subject id", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await listContent(dir, "subject-1"), []);
});

test("addUploadedContent accepts .md, writes raw+parsed files, and records metadata", async () => {
  const dir = await scratchDir();
  const record = await addUploadedContent(dir, "subject-1", {
    filename: "Lecture 1.md",
    text: "# Lecture 1\n\nSome notes.",
  });

  assert.equal(record.subjectId, "subject-1");
  assert.equal(record.originalFilename, "Lecture 1.md");
  assert.equal(record.extension, ".md");
  assert.equal(record.source, "upload");
  assert.equal(record.sizeBytes, Buffer.byteLength("# Lecture 1\n\nSome notes.", "utf8"));
  assert.equal(typeof record.id, "string");
  assert.equal(typeof record.addedAt, "string");
  assert.deepEqual(await listContent(dir, "subject-1"), [record]);

  const dirs = appDataSubdirs(dir);
  const rawPath = path.join(dirs.content, "subject-1", "raw", `${record.id}.md`);
  const parsedPath = path.join(dirs.content, "subject-1", "parsed", `${record.id}.md`);
  assert.equal(await fs.readFile(rawPath, "utf8"), "# Lecture 1\n\nSome notes.");
  assert.equal(await fs.readFile(parsedPath, "utf8"), "# Lecture 1\n\nSome notes.");
});

test("addUploadedContent accepts .txt the same way", async () => {
  const dir = await scratchDir();
  const record = await addUploadedContent(dir, "subject-1", { filename: "notes.txt", text: "plain text" });
  assert.equal(record.extension, ".txt");
});

test("addUploadedContent rejects a missing filename", async () => {
  const dir = await scratchDir();
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "", text: "hi" }),
    /filename is required/i,
  );
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { text: "hi" }),
    /filename is required/i,
  );
});

test("addUploadedContent rejects an unsupported file type and stores nothing", async () => {
  const dir = await scratchDir();
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "slides.pdf", text: "whatever" }),
    /unsupported file type/i,
  );
  assert.deepEqual(await listContent(dir, "subject-1"), []);
});

test("addUploadedContent rejects a filename with no extension", async () => {
  const dir = await scratchDir();
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "README", text: "whatever" }),
    /unsupported file type/i,
  );
});

test("addUploadedContent rejects blank or missing text", async () => {
  const dir = await scratchDir();
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "notes.txt", text: "   " }),
    /content is empty/i,
  );
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "notes.txt" }),
    /content is empty/i,
  );
});

test("addUploadedContent rejects text over the size limit", async () => {
  const dir = await scratchDir();
  const tooBig = "a".repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "huge.txt", text: tooBig }),
    /too large/i,
  );
  assert.deepEqual(await listContent(dir, "subject-1"), []);
});

test("addUploadedContent enforces the per-subject item count limit", async () => {
  const dir = await scratchDir();
  const dirs = appDataSubdirs(dir);
  const store = makeJsonFileStore(dirs.db, "content.json", []);
  const seeded = Array.from({ length: 200 }, (_, i) => ({
    id: `seed-${i}`,
    subjectId: "subject-1",
    originalFilename: `seed-${i}.txt`,
    extension: ".txt",
    source: "upload",
    sizeBytes: 1,
    addedAt: new Date().toISOString(),
  }));
  await store.write(seeded);

  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "one-more.txt", text: "hi" }),
    /maximum of 200/i,
  );
  assert.equal((await listContent(dir, "subject-1")).length, 200);

  // A different subject is unaffected by subject-1's count.
  const record = await addUploadedContent(dir, "subject-2", { filename: "fine.txt", text: "hi" });
  assert.equal(record.subjectId, "subject-2");
});

test("addPastedNotes generates a .md filename and tags the source as paste", async () => {
  const dir = await scratchDir();
  const record = await addPastedNotes(dir, "subject-1", { text: "stuff I learned today" });
  assert.equal(record.source, "paste");
  assert.equal(record.extension, ".md");
  assert.match(record.originalFilename, /^pasted-notes-.+\.md$/);

  const dirs = appDataSubdirs(dir);
  const parsedPath = path.join(dirs.content, "subject-1", "parsed", `${record.id}.md`);
  assert.equal(await fs.readFile(parsedPath, "utf8"), "stuff I learned today");
});

test("addPastedNotes rejects blank text", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => addPastedNotes(dir, "subject-1", { text: "  " }), /content is empty/i);
});

test("addUploadedContent never collides on id across concurrent calls", async () => {
  const dir = await scratchDir();
  const created = await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      addUploadedContent(dir, "subject-1", { filename: `f${i}.txt`, text: `text ${i}` }),
    ),
  );
  const ids = new Set(created.map((c) => c.id));
  assert.equal(ids.size, 15);
  assert.equal((await listContent(dir, "subject-1")).length, 15);
});
