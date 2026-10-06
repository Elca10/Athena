// Thin fetch wrappers for the first-run setup endpoints (server/src/routes/setup.js).
// Kept separate from SetupWizard.tsx so the request/response shape can be
// unit-tested without rendering any component.

export type ClaudeCodeCheck = { installed: boolean; loggedIn?: boolean | null; detail?: string };
export type GithubCheck = { installed: boolean; authenticated?: boolean; detail?: string };
export type GithubConnectState = {
  id: string;
  status: "pending" | "success" | "error";
  rawOutput: string;
  code: string | null;
  verificationUrl: string | null;
  startedAt: number;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} responded ${res.status}`);
  return res.json();
}

export function checkClaudeCode(): Promise<ClaudeCodeCheck> {
  return getJson("/api/setup/claude-code");
}

export function checkGithub(): Promise<GithubCheck> {
  return getJson("/api/setup/github");
}

export async function startGithubConnect(): Promise<{ id: string }> {
  const res = await fetch("/api/setup/github/connect", { method: "POST" });
  if (!res.ok) throw new Error(`POST /api/setup/github/connect responded ${res.status}`);
  return res.json();
}

// 404 means a newer connect flow replaced this one (server/src/githubConnect.js) —
// treated as "no state" rather than an error, since the caller should just
// stop polling this id.
export async function getGithubConnectState(id: string): Promise<GithubConnectState | null> {
  const res = await fetch(`/api/setup/github/connect/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/setup/github/connect/${id} responded ${res.status}`);
  return res.json();
}

export async function completeSetup(): Promise<void> {
  const res = await fetch("/api/setup/complete", { method: "POST" });
  if (!res.ok) throw new Error(`POST /api/setup/complete responded ${res.status}`);
}

export async function getHealth(): Promise<{ ok: boolean; version: string; setupComplete: boolean }> {
  return getJson("/api/health");
}
