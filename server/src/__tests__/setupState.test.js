import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSetupComplete, markSetupComplete } from "../setupState.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-setupstate-"));
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
