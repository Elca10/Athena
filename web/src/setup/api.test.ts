import { afterEach, describe, expect, test, vi } from "vitest";
import {
  checkClaudeCode,
  checkGithub,
  completeSetup,
  createSubject,
  detectOs,
  getGithubConnectState,
  getHealth,
  startGithubConnect,
} from "./api";

function mockFetchOnce(body: unknown, { ok = true, status = 200 } = {}) {
  const json = vi.fn().mockResolvedValue(body);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok, status, json }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectOs", () => {
  test("hits /api/setup/os and returns the parsed detection", async () => {
    mockFetchOnce({ detected: "windows" });
    await expect(detectOs()).resolves.toEqual({ detected: "windows" });
    expect(fetch).toHaveBeenCalledWith("/api/setup/os");
  });
});

describe("checkClaudeCode / checkGithub / getHealth", () => {
  test("return the parsed JSON body on success", async () => {
    mockFetchOnce({ installed: true, loggedIn: true });
    await expect(checkClaudeCode()).resolves.toEqual({ installed: true, loggedIn: true });
  });

  test("throw on a non-ok response rather than silently returning it", async () => {
    mockFetchOnce({}, { ok: false, status: 500 });
    await expect(checkGithub()).rejects.toThrow(/500/);
  });

  test("getHealth hits /api/health", async () => {
    mockFetchOnce({ ok: true, version: "0.1.0", setupComplete: false });
    await getHealth();
    expect(fetch).toHaveBeenCalledWith("/api/health");
  });
});

describe("startGithubConnect", () => {
  test("POSTs and returns the new flow id", async () => {
    mockFetchOnce({ id: "gh-connect-1" });
    await expect(startGithubConnect()).resolves.toEqual({ id: "gh-connect-1" });
    expect(fetch).toHaveBeenCalledWith("/api/setup/github/connect", { method: "POST" });
  });
});

describe("getGithubConnectState", () => {
  test("returns null on a 404 (a newer flow replaced this id) instead of throwing", async () => {
    mockFetchOnce({}, { ok: false, status: 404 });
    await expect(getGithubConnectState("stale-id")).resolves.toBeNull();
  });

  test("returns the parsed state on success", async () => {
    const state = { id: "x", status: "pending", rawOutput: "", code: null, verificationUrl: null, startedAt: 1 };
    mockFetchOnce(state);
    await expect(getGithubConnectState("x")).resolves.toEqual(state);
  });
});

describe("completeSetup", () => {
  test("POSTs to /api/setup/complete and throws on failure", async () => {
    mockFetchOnce({}, { ok: false, status: 500 });
    await expect(completeSetup()).rejects.toThrow(/500/);
  });
});

describe("createSubject", () => {
  test("POSTs the name and returns the created subject", async () => {
    mockFetchOnce({ id: "s1", name: "Organic Chemistry" });
    await expect(createSubject("Organic Chemistry")).resolves.toEqual({ id: "s1", name: "Organic Chemistry" });
    expect(fetch).toHaveBeenCalledWith("/api/subjects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Organic Chemistry" }),
    });
  });

  test("surfaces the server's own error message on failure", async () => {
    mockFetchOnce({ error: "Subject name cannot be blank." }, { ok: false, status: 400 });
    await expect(createSubject("")).rejects.toThrow("Subject name cannot be blank.");
  });
});
