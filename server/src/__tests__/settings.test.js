import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSettings, updateSettings } from "../settings.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-settings-"));
}

test("getSettings defaults bigIdeasPromptEnabled to false for a fresh install", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await getSettings(dir), { bigIdeasPromptEnabled: false });
});

test("updateSettings turns the big-ideas prompt on and getSettings reflects it", async () => {
  const dir = await scratchDir();
  const updated = await updateSettings(dir, { bigIdeasPromptEnabled: true });
  assert.deepEqual(updated, { bigIdeasPromptEnabled: true });
  assert.deepEqual(await getSettings(dir), { bigIdeasPromptEnabled: true });
});

test("updateSettings rejects an unknown key without storing anything", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => updateSettings(dir, { notARealSetting: true }), /unknown setting/i);
  assert.deepEqual(await getSettings(dir), { bigIdeasPromptEnabled: false });
});

test("updateSettings rejects a non-boolean value for bigIdeasPromptEnabled", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => updateSettings(dir, { bigIdeasPromptEnabled: "yes" }), /must be true or false/i);
  assert.deepEqual(await getSettings(dir), { bigIdeasPromptEnabled: false });
});

test("updateSettings with an empty patch is a no-op", async () => {
  const dir = await scratchDir();
  await updateSettings(dir, { bigIdeasPromptEnabled: true });
  const same = await updateSettings(dir, {});
  assert.deepEqual(same, { bigIdeasPromptEnabled: true });
});
