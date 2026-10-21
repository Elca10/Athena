import { test } from "node:test";
import assert from "node:assert/strict";
import { getPersonaBlock, _resetPersonaCacheForTests } from "../persona/persona.js";

test("getPersonaBlock strips the doc's own title and returns the voice guidance", () => {
  const block = getPersonaBlock();
  assert.doesNotMatch(block, /^# Athena/);
  assert.match(block, /Impersonal and direct/);
  assert.match(block, /Never refer to yourself by name/);
});

// Paid for on every model call that includes it (SPEC-v2.md section 5: "keep
// the prompt-included portion tight, target <= 350 words").
test("getPersonaBlock stays within the ~350-word prompt budget", () => {
  const wordCount = getPersonaBlock().split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount <= 350, `persona block is ${wordCount} words, over the 350-word budget`);
});

// Item 1 of the owner's answers: Athena's voice is impersonal — no
// first-person narration of its own reasoning. The doc legitimately shows
// "I think you missed..." once, but only as the explicit counter-example
// right after "don't narrate your own thinking" — this checks it's never
// instructed as the thing TO do.
test("getPersonaBlock never instructs a first-person voice", () => {
  const block = getPersonaBlock();
  assert.match(block, /don't narrate\s+your own thinking/);
  assert.doesNotMatch(block, /\bI believe\b/);
  const firstPersonMentions = block.match(/\bI (?:think|believe|feel)\b/g) ?? [];
  assert.equal(firstPersonMentions.length, 1, "first-person phrasing should appear at most once, as the counter-example");
});

test("getPersonaBlock never mentions Athena by name inside the voice guidance itself", () => {
  // The doc's own title (stripped above) is the only place "Athena" should
  // appear — the voice guidance explicitly forbids self-reference by name
  // in generated text, so the guidance shouldn't contradict itself by
  // naming it either.
  assert.doesNotMatch(getPersonaBlock(), /Athena/);
});

test("getPersonaBlock caches after the first read", () => {
  _resetPersonaCacheForTests();
  const first = getPersonaBlock();
  const second = getPersonaBlock();
  assert.equal(first, second);
});
