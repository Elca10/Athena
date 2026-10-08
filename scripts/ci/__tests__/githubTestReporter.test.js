// Feeds synthetic node:test reporter events through the real generator
// (not a reimplementation of its logic) and asserts on the exact
// `::error::` workflow-command lines it yields, since those are the only
// thing GitHub's public check-run annotations API surfaces without the
// job-log auth this build doesn't have (see athena-build/brief.md
// priority item 0).

import { test } from "node:test";
import assert from "node:assert/strict";
import githubTestReporter from "../githubTestReporter.mjs";

async function collect(events) {
  const lines = [];
  for await (const chunk of githubTestReporter(events)) {
    lines.push(chunk);
  }
  return lines;
}

function failEvent(data) {
  return { type: "test:fail", data };
}

test("ignores non-failure events", async () => {
  const lines = await collect([
    { type: "test:pass", data: { name: "ok" } },
    { type: "test:diagnostic", data: {} },
  ]);
  assert.deepEqual(lines, []);
});

test("emits an ::error:: line with file, line, and title for a failing test", async () => {
  const lines = await collect([
    failEvent({
      name: "my test",
      file: "/repo/scripts/__tests__/thing.test.js",
      line: 12,
      details: { error: { cause: { message: "expected true, got false" } } },
    }),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
    "::error file=/repo/scripts/__tests__/thing.test.js,line=12,title=my test::expected true, got false\n",
  );
});

test("falls back to error.message when there is no cause", async () => {
  const lines = await collect([
    failEvent({
      name: "t",
      details: { error: { message: "boom" } },
    }),
  ]);
  assert.match(lines[0], /::boom\n$/);
});

test("takes only the first line of a multi-line message", async () => {
  const lines = await collect([
    failEvent({
      name: "t",
      details: { error: { cause: { message: "line one\n\nline two" } } },
    }),
  ]);
  assert.match(lines[0], /::line one\n$/);
});

test("escapes %, CR, and LF in the message, and additionally : and , in properties", async () => {
  const lines = await collect([
    failEvent({
      name: "weird: name, 100%",
      file: "f.js",
      details: { error: { cause: { message: "100%\rdone" } } },
    }),
  ]);
  assert.equal(
    lines[0],
    "::error file=f.js,title=weird%3A name%2C 100%25::100%25%0Ddone\n",
  );
});

test("omits file/line properties when absent, but still includes title", async () => {
  const lines = await collect([
    failEvent({ name: "no location", details: { error: { message: "x" } } }),
  ]);
  assert.equal(lines[0], "::error title=no location::x\n");
});

test("handles a missing error object without throwing", async () => {
  const lines = await collect([failEvent({ name: "no error", details: {} })]);
  assert.equal(lines[0], "::error title=no error::failed\n");
});
