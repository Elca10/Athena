import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolveExecutable, waitForHealth, openBrowser } from "../bootstrap.mjs";

test("resolveExecutable: appends .cmd for npm/npx on win32 only", () => {
  assert.equal(resolveExecutable("npm", "win32"), "npm.cmd");
  assert.equal(resolveExecutable("npx", "win32"), "npx.cmd");
  assert.equal(resolveExecutable("node", "win32"), "node");
  assert.equal(resolveExecutable("git", "win32"), "git");
  assert.equal(resolveExecutable("npm", "darwin"), "npm");
  assert.equal(resolveExecutable("npm", "linux"), "npm");
});

test("waitForHealth resolves as soon as the endpoint reports ok:true", async () => {
  let callCount = 0;
  const fetchFn = async () => {
    callCount += 1;
    if (callCount < 3) throw new Error("ECONNREFUSED (server not up yet)");
    return { ok: true, version: "0.1.0", setupComplete: false };
  };
  const delays = [];
  const delayFn = async (ms) => {
    delays.push(ms);
  };

  const body = await waitForHealth("http://127.0.0.1:0/api/health", { fetchFn, delayFn, intervalMs: 50 });
  assert.equal(body.ok, true);
  assert.equal(callCount, 3);
  assert.deepEqual(delays, [50, 50]);
});

test("waitForHealth against a real ephemeral-port server", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const body = await waitForHealth(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 2000, intervalMs: 20 });
    assert.equal(body.ok, true);
  } finally {
    server.close();
  }
});

test("waitForHealth times out when nothing ever answers", async () => {
  const fetchFn = async () => {
    throw new Error("ECONNREFUSED");
  };
  const delayFn = async () => {};
  await assert.rejects(
    waitForHealth("http://127.0.0.1:1/api/health", { fetchFn, delayFn, timeoutMs: 1 }),
    /Timed out waiting/,
  );
});

test("openBrowser picks the right command per platform and never throws", () => {
  const calls = [];
  function fakeSpawn(command, args) {
    calls.push({ command, args });
    return { unref() {}, on() {} };
  }

  openBrowser("http://127.0.0.1:4417/", { platform: "darwin", spawnFn: fakeSpawn });
  openBrowser("http://127.0.0.1:4417/", { platform: "win32", spawnFn: fakeSpawn });
  openBrowser("http://127.0.0.1:4417/", { platform: "linux", spawnFn: fakeSpawn });

  assert.deepEqual(calls[0], { command: "open", args: ["http://127.0.0.1:4417/"] });
  assert.deepEqual(calls[1], { command: "cmd", args: ["/c", "start", "", "http://127.0.0.1:4417/"] });
  assert.deepEqual(calls[2], { command: "xdg-open", args: ["http://127.0.0.1:4417/"] });
});

test("openBrowser swallows a spawn failure instead of throwing (headless/no-browser case)", () => {
  const spawnFn = () => {
    throw new Error("no display");
  };
  assert.doesNotThrow(() => openBrowser("http://127.0.0.1:4417/", { platform: "linux", spawnFn }));
});
