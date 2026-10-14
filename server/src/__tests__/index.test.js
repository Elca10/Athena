import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeGhOnPath } from "./fakeGhOnPath.js";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const INDEX_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Scratch, collision-proof data dir for every test in this file — must be
// set before createApp() runs (though dataDir.js itself re-reads
// process.env on every call rather than caching at import time, so there's
// no module-load-order hazard here — isolating real test runs from a real
// user's app-data dir is still the point).
let scratchDir;

test.before(async () => {
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-index-test-"));
  process.env.ATHENA_DATA_DIR = scratchDir;
});

test.after(() => {
  delete process.env.ATHENA_DATA_DIR;
});

test("GET /api/health reports ok and an unset-up app", async () => {
  const { createApp } = await import("../index.js");
  const { app, appDataDir } = await createApp();
  assert.equal(appDataDir, scratchDir);

  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.setupComplete, false);
    assert.equal(typeof body.version, "string");
  } finally {
    server.close();
  }
});

test("GET /api/health names the commit this process started on (issue #4)", async () => {
  const { execFileSync } = await import("node:child_process");
  const repoRoot = path.resolve(path.dirname(INDEX_PATH), "..", "..");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(body.commit, head);
  } finally {
    server.close();
  }
});

test("GET /api/setup/os reports a real detected OS (windows, mac, or other)", async () => {
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/setup/os`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(["windows", "mac", "other"].includes(body.detected));
  } finally {
    server.close();
  }
});

test("POST /api/bug-report/preview rejects an empty description", async () => {
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bug-report/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "   " }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /api/bug-report/preview then /send files through a fake gh and returns the issue URL", async () => {
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();

  // runCommand (processUtil.js) inherits process.env when no `env` is
  // passed, and the route layer never exposes an env override (on
  // purpose — only this test file's own env, not a production code
  // path, needs to point `gh` at a fake). Save/restore so no other test
  // in this process sees the fake PATH.
  const fake = await fakeGhOnPath({ mode: "success", url: "https://github.com/Elca10/Athena/issues/999" });
  const savedEnv = { ...process.env };
  Object.assign(process.env, fake.env);

  try {
    const previewRes = await fetch(`http://127.0.0.1:${port}/api/bug-report/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "the Ready session hangs after I answer" }),
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    assert.ok(preview.title.startsWith("Bug report: "));
    assert.match(preview.body, /the Ready session hangs after I answer/);

    const sendRes = await fetch(`http://127.0.0.1:${port}/api/bug-report/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preview),
    });
    assert.equal(sendRes.status, 200);
    const sendBody = await sendRes.json();
    assert.deepEqual(sendBody, { ok: true, url: "https://github.com/Elca10/Athena/issues/999" });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    server.close();
  }
});

test("POST /api/bug-report/send rejects a request with no previewed title/body", async () => {
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bug-report/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /api/setup/complete then GET /api/health reflects setupComplete:true", async () => {
  const { createApp } = await import("../index.js");
  const { app } = await createApp();
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const postRes = await fetch(`http://127.0.0.1:${port}/api/setup/complete`, { method: "POST" });
    assert.equal(postRes.status, 200);

    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await healthRes.json();
    assert.equal(body.setupComplete, true);
  } finally {
    server.close();
  }
});

// Regression test for the Windows `import.meta.url === \`file://${process.argv[1]}\``
// entry-point bug (found 2026-10-12, same day as the npm.cmd installer
// hotfix): process.argv[1] is a native OS path (backslashes, no file://
// prefix on Windows), so that bare template comparison can never match
// there — main() silently never ran, with zero output, on real Windows,
// even though it "happened to work" on POSIX. Every other test in this
// file imports `createApp` as a module, which never exercises this guard
// at all (import.meta.url only equals pathToFileURL(process.argv[1]).href
// when the file is the process's own directly-invoked entry script) — so
// this exact gap was invisible to every OS in CI, including
// windows-latest, until this test actually spawns the real file.
test("entry-point guard: running index.js directly for real invokes main() and starts listening", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "athena-index-direct-"));
  const port = await findFreePort();
  const child = spawn(process.execPath, [INDEX_PATH], {
    env: { ...process.env, ATHENA_PORT: String(port), ATHENA_DATA_DIR: scratch },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  try {
    const deadline = Date.now() + 5000;
    while (!stdout.includes("Athena-Studying backend listening") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(stdout, /Athena-Studying backend listening/, `main() never started listening.\nstderr:\n${stderr}`);

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    child.kill();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
