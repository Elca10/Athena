// Exercises resolveRevArgs' DI-injectable GitHub-event-payload logic
// directly (no real event file or git repo needed — findMisplacedReleaseTrailers
// itself, which this script just wires up for CI, already has its own
// real-git coverage in scripts/__tests__/promote-release.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRevArgs } from "../check-release-trailers.mjs";

const FALLBACK = ["-20", "HEAD"];

test("resolveRevArgs: no event path at all falls back to the last 20 commits", () => {
  assert.deepEqual(resolveRevArgs({ eventPath: undefined }), FALLBACK);
});

test("resolveRevArgs: event path that doesn't exist falls back", () => {
  assert.deepEqual(resolveRevArgs({ eventPath: "/no/such/file", pathExists: () => false }), FALLBACK);
});

test("resolveRevArgs: a real, reachable before SHA becomes before..HEAD", () => {
  const result = resolveRevArgs({
    eventPath: "/fake/event.json",
    pathExists: () => true,
    readEventFile: () => JSON.stringify({ before: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
    commitExists: (sha) => sha === "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  });
  assert.deepEqual(result, ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..HEAD"]);
});

test("resolveRevArgs: an all-zeros before (brand-new branch) falls back", () => {
  const result = resolveRevArgs({
    eventPath: "/fake/event.json",
    pathExists: () => true,
    readEventFile: () => JSON.stringify({ before: "0000000000000000000000000000000000000000" }),
    commitExists: () => {
      throw new Error("must not be called for an all-zeros before");
    },
  });
  assert.deepEqual(result, FALLBACK);
});

test("resolveRevArgs: a before SHA that isn't reachable (e.g. shallow checkout) falls back", () => {
  const result = resolveRevArgs({
    eventPath: "/fake/event.json",
    pathExists: () => true,
    readEventFile: () => JSON.stringify({ before: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
    commitExists: () => false,
  });
  assert.deepEqual(result, FALLBACK);
});

test("resolveRevArgs: missing before field falls back", () => {
  const result = resolveRevArgs({
    eventPath: "/fake/event.json",
    pathExists: () => true,
    readEventFile: () => JSON.stringify({ ref: "refs/heads/main" }),
  });
  assert.deepEqual(result, FALLBACK);
});

test("resolveRevArgs: unreadable/invalid event payload falls back instead of throwing", () => {
  const result = resolveRevArgs({
    eventPath: "/fake/event.json",
    pathExists: () => true,
    readEventFile: () => "not json",
  });
  assert.deepEqual(result, FALLBACK);
});
