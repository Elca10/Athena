#!/usr/bin/env node
// Cross-platform half of the one-command installer (SPEC.md section 2).
// `installers/macos.sh` (and, later, a Windows PowerShell script) only
// solve the chicken-and-egg problem of getting git + Node + a checkout
// onto a machine that may have neither yet; once that's done, they hand
// off to this file for everything else, so the actual install logic is
// written once, in the same language as the rest of the app, and is
// unit-testable the normal way (unlike the shell bootstrap around it).
//
// Deliberately does NOT depend on `cross-spawn` (server/src/processUtil.js)
// or any other npm package: this script runs BEFORE `npm install` has put
// anything on disk, and it runs again on every future auto-update restart
// (SPEC.md section 2), so it must work with nothing but a bare Node
// install, every time.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Pure function (platform injected for testability, same pattern as
 * dataDir.js's resolveAppDataDir): on Windows, `npm`/`npx` are `.cmd`
 * shims that Node's own `child_process.spawn` only resolves reliably with
 * `shell: true` — which this file deliberately avoids (SPEC.md section 2:
 * "no shell-string exec"). `cross-spawn` normally handles this (see
 * processUtil.js) but isn't available yet here. `git` and `node` are real
 * executables on every OS and need no special-casing.
 */
export function resolveExecutable(command, platform = process.platform) {
  if (platform === "win32" && (command === "npm" || command === "npx")) {
    return `${command}.cmd`;
  }
  return command;
}

/** Runs a command to completion, streaming its output straight to this
 * process's own stdio so the person running the installer sees progress
 * (npm install output, etc.) rather than a silent hang. */
function run(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutable(command), args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`\`${command} ${args.join(" ")}\` exited with code ${code}`));
    });
  });
}

/** Starts the backend server as a detached process that outlives this
 * script, and returns immediately — `main()` below still waits for it to
 * report healthy before declaring the install done. */
function startServerDetached({ cwd, env } = {}) {
  const child = spawn(resolveExecutable("node"), [path.join(cwd, "server", "src", "index.js")], {
    cwd,
    stdio: "ignore",
    detached: true,
    env,
  });
  child.unref();
  return child;
}

/**
 * Polls a health URL (expects `{ok: true, ...}` JSON, matching
 * server/src/routes/health.js) until it answers or `timeoutMs` elapses.
 * `fetchFn`/`delayFn` are injectable so tests can run this against a real
 * ephemeral-port server without a real multi-second sleep.
 */
export async function waitForHealth(
  url,
  { timeoutMs = 30_000, intervalMs = 300, fetchFn = defaultFetch, delayFn = defaultDelay } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const body = await fetchFn(url);
      if (body && body.ok === true) return body;
      lastError = new Error(`Unexpected health response: ${JSON.stringify(body)}`);
    } catch (err) {
      lastError = err;
    }
    await delayFn(intervalMs);
  }
  throw new Error(`Timed out waiting for ${url} to report healthy: ${lastError?.message ?? "no response"}`);
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultFetch(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
  });
}

/** Best-effort only: a friend with no GUI (CI, a headless box) should
 * still get a fully running server, just without a browser tab popping
 * open for them — never fail the install over this. `spawnFn` is
 * injectable so tests can assert the right command/args per platform
 * without actually launching a browser. */
export function openBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawnFn(command, args, { stdio: "ignore", detached: true });
    child.unref?.();
    child.on?.("error", () => {});
  } catch {
    // Headless/no browser available — not fatal.
  }
}

async function main() {
  console.log("==> Installing git hooks (privacy guard)...");
  await run("node", [path.join(REPO_ROOT, "scripts", "install-hooks.js")], { cwd: REPO_ROOT });

  console.log("==> Installing server dependencies...");
  await run("npm", ["install"], { cwd: path.join(REPO_ROOT, "server") });

  const webPackageJson = path.join(REPO_ROOT, "web", "package.json");
  if (existsSync(webPackageJson)) {
    console.log("==> Installing and building the web UI...");
    await run("npm", ["install"], { cwd: path.join(REPO_ROOT, "web") });
    await run("npm", ["run", "build"], { cwd: path.join(REPO_ROOT, "web") });
  } else {
    console.log("==> web/ has no UI build yet (still under construction) — skipping.");
  }

  console.log("==> Starting the Athena-Studying server...");
  startServerDetached({ cwd: REPO_ROOT, env: process.env });

  const port = process.env.ATHENA_PORT || 4417;
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  await waitForHealth(healthUrl);

  const appUrl = `http://127.0.0.1:${port}/`;
  console.log(`\nAthena-Studying is running: ${appUrl}`);
  if (!process.env.ATHENA_NO_OPEN_BROWSER) openBrowser(appUrl);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`Athena-Studying install failed: ${err.message}`);
    process.exit(1);
  });
}
