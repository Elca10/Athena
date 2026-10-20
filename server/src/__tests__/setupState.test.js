import { test } from "node:test";
import assert from "node:assert/strict";
import { isSetupComplete, markSetupComplete } from "../setupState.js";
import { makeTempDir } from "../testHelpers/tempDir.js";

async function scratchDir() {
  return makeTempDir("athena-setupstate-");
}

test("isSetupComplete is false before anything has been marked", async () => {
  const dir = await scratchDir();
  assert.equal(await isSetupComplete(dir), false);
});

test("markSetupComplete persists, and isSetupComplete reflects it afterwards", async () => {
  const dir = await scratchDir();
  await markSetupComplete(dir);
  assert.equal(await isSetupComplete(dir), true);
});
