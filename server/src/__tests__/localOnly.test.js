import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { refusalReason } from "../localOnly.js";

const own = { host: "127.0.0.1:4417" };
const post = (headers) => refusalReason({ method: "POST", headers });

test("refusalReason: any request must name a loopback host (DNS rebinding)", () => {
  for (const host of ["127.0.0.1:4417", "localhost:4417", "LOCALHOST:4417", "[::1]:4417", "127.0.0.1"]) {
    assert.equal(refusalReason({ method: "GET", headers: { host } }), null, host);
  }
  for (const host of ["evil.example:4417", "evil.example", "127.0.0.1.evil.example:4417", "", undefined]) {
    assert.equal(refusalReason({ method: "GET", headers: { host } }), "host", String(host));
  }
});

test("refusalReason: a configured non-loopback host is allowed too", () => {
  assert.equal(refusalReason({ method: "GET", headers: { host: "study-box:4417" } }, { extraHost: "study-box" }), null);
});

test("refusalReason: Athena's own page can change things", () => {
  assert.equal(post({ ...own, origin: "http://127.0.0.1:4417", "sec-fetch-site": "same-origin" }), null);
  assert.equal(post({ host: "localhost:4417", origin: "http://localhost:4417" }), null);
});

test("refusalReason: no Origin at all (curl, installers, tests) passes", () => {
  assert.equal(post(own), null);
});

test("refusalReason: another site, or another local port, can't change things", () => {
  assert.equal(post({ ...own, origin: "https://evil.example" }), "origin");
  assert.equal(post({ ...own, origin: "http://127.0.0.1:3000" }), "origin");
  assert.equal(post({ ...own, origin: "http://localhost:4417" }), "origin");
  assert.equal(post({ ...own, origin: "null" }), "origin");
  assert.equal(post({ ...own, "sec-fetch-site": "cross-site" }), "cross-site");
  assert.equal(post({ ...own, "sec-fetch-site": "same-site" }), "cross-site");
});

test("refusalReason: following a link from another site still opens Athena", () => {
  assert.equal(refusalReason({ method: "GET", headers: { ...own, "sec-fetch-site": "cross-site" } }), null);
});

function request(port, { method = "GET", path: urlPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : "{}");
  });
}

test("the real app refuses a rebinding host and a cross-site POST, and serves its own page", async () => {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-localonly-test-"));
  process.env.ATHENA_DATA_DIR = scratchDir;
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const host = `127.0.0.1:${port}`;
  const json = { "content-type": "application/json" };
  try {
    assert.equal((await request(port, { path: "/api/health", headers: { host } })).status, 200);
    assert.equal((await request(port, { path: "/api/health", headers: { host: `evil.example:${port}` } })).status, 403);

    const subject = { method: "POST", path: "/api/subjects" };
    const crossSite = await request(port, { ...subject, headers: { ...json, host, origin: "https://evil.example" } });
    assert.equal(crossSite.status, 403);
    assert.match(crossSite.body, /only accepts requests from its own page/);
    // Same request from Athena's own page gets past the guard (a 400 for
    // the empty body, not a 403).
    const own = await request(port, { ...subject, headers: { ...json, host, origin: `http://${host}` } });
    assert.notEqual(own.status, 403);
  } finally {
    server.close();
    delete process.env.ATHENA_DATA_DIR;
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
});
