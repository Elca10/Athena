import { test } from "node:test";
import assert from "node:assert/strict";
import { recordError, getRecentErrorLines, clearRecentErrors } from "../errorLog.js";

test.beforeEach(() => {
  clearRecentErrors();
});

test("getRecentErrorLines is empty before anything is recorded", () => {
  assert.deepEqual(getRecentErrorLines(), []);
});

test("recordError prefixes an ISO timestamp and keeps the message", () => {
  recordError("something broke");
  const [line] = getRecentErrorLines();
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z something broke$/);
});

test("getRecentErrorLines returns entries oldest-first, most recent last", () => {
  recordError("first");
  recordError("second");
  recordError("third");
  const lines = getRecentErrorLines();
  assert.equal(lines.length, 3);
  assert.ok(lines[0].endsWith("first"));
  assert.ok(lines[1].endsWith("second"));
  assert.ok(lines[2].endsWith("third"));
});

test("getRecentErrorLines(limit) returns only the most recent `limit` entries", () => {
  for (let i = 0; i < 5; i++) recordError(`entry ${i}`);
  const lines = getRecentErrorLines(2);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith("entry 3"));
  assert.ok(lines[1].endsWith("entry 4"));
});

test("the buffer drops the oldest entry once it exceeds its cap", () => {
  for (let i = 0; i < 60; i++) recordError(`entry ${i}`);
  const lines = getRecentErrorLines(60);
  // Capped at 50 — the oldest 10 (entry 0..9) must be gone, the newest
  // (entry 59) must still be present.
  assert.equal(lines.length, 50);
  assert.ok(!lines.some((l) => l.endsWith("entry 9")));
  assert.ok(lines.some((l) => l.endsWith("entry 59")));
});

test("clearRecentErrors empties the buffer", () => {
  recordError("will be cleared");
  clearRecentErrors();
  assert.deepEqual(getRecentErrorLines(), []);
});
