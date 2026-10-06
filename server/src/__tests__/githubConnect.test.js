import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGhLoginOutput } from "../githubConnect.js";

test("parseGhLoginOutput extracts the one-time code and verification URL from real-shaped gh output", () => {
  const sample = [
    "! First copy your one-time code: ABCD-1234",
    "- Press Enter to open github.com in your browser...",
    "https://github.com/login/device",
  ].join("\n");
  assert.deepEqual(parseGhLoginOutput(sample), {
    code: "ABCD-1234",
    verificationUrl: "https://github.com/login/device",
  });
});

test("parseGhLoginOutput returns nulls when nothing matches yet (output still arriving)", () => {
  assert.deepEqual(parseGhLoginOutput("Starting login flow...\n"), { code: null, verificationUrl: null });
});

test("parseGhLoginOutput ignores unrelated short uppercase-ish tokens", () => {
  const result = parseGhLoginOutput("Hostname: GITHUB.COM\nSomething: ABC-123\n");
  // "ABC-123" doesn't match the 4-4 shape, so this should stay null, not a
  // false positive.
  assert.equal(result.code, null);
});
