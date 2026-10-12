import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText } from "../redact.js";

// SPEC.md section 3 is explicit that a leak here is severity-1 — this
// file is deliberately heavy on cases, including ones that look like
// they'd be redacted but structurally aren't (SPEC.md doesn't actually
// promise those), so a future change can't quietly narrow coverage
// without a test noticing.
//
// Placeholder names below ("someone", "friend", "tester") are the same
// safe-path-name convention check-privacy.js's own SAFE_PATH_NAMES list
// already documents (see dataDir.test.js) — this file's fixtures are
// fake personal-data SHAPES on purpose, so they have to avoid tripping
// that same guard on themselves.

test("redacts a POSIX /home/<user>/ path, keeping the rest of the path", () => {
  const result = redactText("crash reading /home/someone/Desktop/notes.txt");
  assert.equal(result, "crash reading /home/<user>/Desktop/notes.txt");
});

test("redacts a macOS /Users/<user>/ path, keeping the rest of the path", () => {
  const result = redactText("saved to /Users/someone/Library/Application Support/Athena-Studying/db");
  assert.equal(result, "saved to /Users/<user>/Library/Application Support/Athena-Studying/db");
});

test("redacts a Windows C:\\Users\\<user>\\ path with backslashes", () => {
  const result = redactText("at C:\\Users\\someone\\AppData\\Roaming\\Athena-Studying\\logs\\error.log");
  assert.equal(result, "at C:\\Users\\<user>\\AppData\\Roaming\\Athena-Studying\\logs\\error.log");
});

test("redacts a Windows path with forward slashes", () => {
  const result = redactText("at C:/Users/someone/AppData/Roaming");
  assert.equal(result, "at C:/Users/<user>/AppData/Roaming");
});

test("redacts a Windows path regardless of drive letter", () => {
  const result = redactText("D:\\Users\\someone\\stuff");
  assert.equal(result, "D:\\Users\\<user>\\stuff");
});

test("redacts multiple home paths in the same text, independently", () => {
  const result = redactText("moved /home/someone/a.txt to /home/friend/b.txt");
  assert.equal(result, "moved /home/<user>/a.txt to /home/<user>/b.txt");
});

test("redacts an email address", () => {
  const result = redactText("contact me at someone.jones+bugs@example.com about this");
  assert.equal(result, "contact me at <email> about this");
});

test("redacts multiple email addresses", () => {
  const result = redactText("cc someone@example.com and friend@example.org");
  assert.equal(result, "cc <email> and <email>");
});

test("redacts a known subject name, case-insensitively", () => {
  const result = redactText("my csc4553 session keeps crashing", { subjectNames: ["CSC4553"] });
  assert.equal(result, "my <subject> session keeps crashing");
});

test("redacts a known topic name wherever it appears", () => {
  const result = redactText("the question about Krebs cycle was wrong", { topicNames: ["Krebs cycle"] });
  assert.equal(result, "the question about <topic> was wrong");
});

test("redacts the longer of two overlapping known names, not a truncated partial match", () => {
  // "CSC" is a substring of "CSC4553" — redacting short-to-long first
  // would leave "<subject>4553" instead of a single clean "<subject>".
  const result = redactText("CSC4553 is my hardest class", { subjectNames: ["CSC", "CSC4553"] });
  assert.equal(result, "<subject> is my hardest class");
});

test("redacts an extra literal (OS username) wherever it appears, not just inside a path", () => {
  const result = redactText("chris mentioned this happened twice", { extraLiterals: ["chris"] });
  assert.equal(result, "<redacted> mentioned this happened twice");
});

test("redacts an extra literal case-insensitively", () => {
  const result = redactText("Chris's laptop", { extraLiterals: ["chris"] });
  assert.equal(result, "<redacted>'s laptop");
});

test("combines several redaction categories in one pass", () => {
  const result = redactText("someone@example.com reported /home/someone/CSC4553/notes.txt is broken in csc4553", {
    subjectNames: ["CSC4553"],
    extraLiterals: ["someone"],
  });
  assert.equal(result, "<email> reported /home/<user>/<subject>/notes.txt is broken in <subject>");
});

test("leaves ordinary text with no personal data untouched", () => {
  const text = "The Ready session hangs after I answer a multiple-choice question.";
  assert.equal(redactText(text), text);
});

test("never throws on non-string input; nullish input becomes an empty string rather than the literal word 'null'", () => {
  assert.equal(redactText(null), "");
  assert.equal(redactText(undefined), "");
  assert.equal(redactText(42), "42");
});

test("never throws on text containing regex-special characters in a known name", () => {
  const result = redactText("what about C++ (intro)?", { subjectNames: ["C++ (intro)"] });
  assert.equal(result, "what about <subject>?");
});

test("handles an empty known-names list without redacting anything extra", () => {
  const text = "nothing personal here";
  assert.equal(redactText(text, { subjectNames: [], topicNames: [], extraLiterals: [] }), text);
});

test("does not redact a username-shaped word that isn't actually a home path or known literal", () => {
  // Deliberately documents a real limitation rather than asserting
  // something this function doesn't promise: a bare word that happens to
  // match nothing passed in is left alone.
  const result = redactText("my friend chris helped me set this up", { extraLiterals: [] });
  assert.equal(result, "my friend chris helped me set this up");
});
