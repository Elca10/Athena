import { test } from "node:test";
import assert from "node:assert/strict";
import { getSettings, updateSettings } from "../settings.js";
import { makeTempDir } from "../testHelpers/tempDir.js";

async function scratchDir() {
  return makeTempDir("athena-settings-");
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
