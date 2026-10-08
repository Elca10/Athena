import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPreferencesBlock } from "../preferencesPrompt.js";

test("formatPreferencesBlock returns an empty string for no preferences", () => {
  assert.equal(formatPreferencesBlock([]), "");
  assert.equal(formatPreferencesBlock(undefined), "");
  assert.equal(formatPreferencesBlock(null), "");
});

test("formatPreferencesBlock lists each preference's text as a bullet", () => {
  const block = formatPreferencesBlock([{ id: "1", text: "harder questions on proofs" }, { id: "2", text: "always give a worked example after a miss" }]);
  assert.match(block, /standing study preferences/);
  assert.match(block, /- harder questions on proofs/);
  assert.match(block, /- always give a worked example after a miss/);
});

test("formatPreferencesBlock accepts plain strings too", () => {
  const block = formatPreferencesBlock(["be concise"]);
  assert.match(block, /- be concise/);
});

test("formatPreferencesBlock skips blank or non-string entries", () => {
  const block = formatPreferencesBlock([{ text: "   " }, { text: "real one" }, { text: 5 }]);
  const bulletLines = block.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(bulletLines, ["- real one"]);
});
