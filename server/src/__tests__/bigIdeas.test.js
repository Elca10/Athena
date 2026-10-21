import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBigIdeas, setBigIdeas, MAX_BIG_IDEAS_CHARS, MAX_HISTORY_VERSIONS } from "../bigIdeas.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-bigideas-"));
}

test("getBigIdeas returns an empty record for a subject with nothing saved yet", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await getBigIdeas(dir, "subject-1"), {
    subjectId: "subject-1",
    text: "",
    updatedAt: null,
    history: [],
  });
});

test("setBigIdeas trims and stores the text, with no history on the first save", async () => {
  const dir = await scratchDir();
  const record = await setBigIdeas(dir, "subject-1", "  Energy is conserved; entropy increases.  ");
  assert.equal(record.text, "Energy is conserved; entropy increases.");
  assert.equal(typeof record.updatedAt, "string");
  assert.deepEqual(record.history, []);
  assert.deepEqual(await getBigIdeas(dir, "subject-1"), record);
});

test("setBigIdeas pushes the previous text onto history when it actually changes", async () => {
  const dir = await scratchDir();
  const first = await setBigIdeas(dir, "subject-1", "Draft one");
  const second = await setBigIdeas(dir, "subject-1", "Draft two");
  assert.equal(second.text, "Draft two");
  assert.deepEqual(second.history, [{ text: "Draft one", updatedAt: first.updatedAt }]);
});

test("setBigIdeas does not grow history when the text is unchanged", async () => {
  const dir = await scratchDir();
  await setBigIdeas(dir, "subject-1", "Same text");
  const again = await setBigIdeas(dir, "subject-1", "Same text");
  assert.deepEqual(again.history, []);
});

test("setBigIdeas caps history at the last N versions", async () => {
  const dir = await scratchDir();
  for (let i = 0; i < MAX_HISTORY_VERSIONS + 5; i++) {
    await setBigIdeas(dir, "subject-1", `Draft ${i}`);
  }
  const record = await getBigIdeas(dir, "subject-1");
  assert.equal(record.history.length, MAX_HISTORY_VERSIONS);
  // Oldest drafts are the ones dropped; the most recent prior drafts remain.
  assert.equal(record.history[0].text, "Draft 4");
  assert.equal(record.history.at(-1).text, `Draft ${MAX_HISTORY_VERSIONS + 3}`);
});

test("setBigIdeas rejects text over the length limit, without touching the stored value", async () => {
  const dir = await scratchDir();
  await setBigIdeas(dir, "subject-1", "kept");
  await assert.rejects(
    () => setBigIdeas(dir, "subject-1", "x".repeat(MAX_BIG_IDEAS_CHARS + 1)),
    /too long/i,
  );
  const record = await getBigIdeas(dir, "subject-1");
  assert.equal(record.text, "kept");
});

test("setBigIdeas allows clearing the text back to empty, and that's still a tracked edit", async () => {
  const dir = await scratchDir();
  await setBigIdeas(dir, "subject-1", "Something");
  const cleared = await setBigIdeas(dir, "subject-1", "");
  assert.equal(cleared.text, "");
  assert.equal(cleared.history.length, 1);
  assert.equal(cleared.history[0].text, "Something");
  assert.equal(typeof cleared.history[0].updatedAt, "string");
});

test("setBigIdeas restoring a past version is just saving it again, tracking the discarded edit too", async () => {
  const dir = await scratchDir();
  await setBigIdeas(dir, "subject-1", "Good version");
  await setBigIdeas(dir, "subject-1", "Bad edit");
  const restored = await setBigIdeas(dir, "subject-1", "Good version");
  assert.equal(restored.text, "Good version");
  assert.deepEqual(
    restored.history.map((h) => h.text),
    ["Good version", "Bad edit"],
  );
});

test("different subjects' big ideas never collide", async () => {
  const dir = await scratchDir();
  await setBigIdeas(dir, "subject-1", "Subject one's ideas");
  await setBigIdeas(dir, "subject-2", "Subject two's ideas");
  assert.equal((await getBigIdeas(dir, "subject-1")).text, "Subject one's ideas");
  assert.equal((await getBigIdeas(dir, "subject-2")).text, "Subject two's ideas");
});
