import { test } from "node:test";
import assert from "node:assert/strict";
import { trimToSentences } from "../textLimits.js";

test("trimToSentences leaves text within the limit alone", () => {
  assert.equal(trimToSentences("Short. Fine.", 50), "Short. Fine.");
});

test("trimToSentences cuts at the last whole sentence that fits", () => {
  const text = "First point is right. Second point is missing. Third sentence runs far past the limit here.";
  assert.equal(trimToSentences(text, 60), "First point is right. Second point is missing.");
});

test("trimToSentences doesn't treat a decimal point as a sentence end", () => {
  const text = "Pi is about 3.14 and that matters here. More text that goes past the limit.";
  assert.equal(trimToSentences(text, 45), "Pi is about 3.14 and that matters here.");
});

test("trimToSentences falls back to a word boundary and an ellipsis when no sentence fits", () => {
  const out = trimToSentences("one two three four five six seven eight nine ten", 20);
  assert.equal(out, "one two three four…");
  assert.ok(out.length <= 20);
});
