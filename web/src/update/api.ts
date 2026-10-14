// Fetch wrappers for one-click updates (server/src/routes/update.js and
// routes/health.js). Kept separate from the component so the shapes are
// typed in one place.

export type LastUpdate = {
  result: "updated" | "rolled-back" | "failed" | "cancelled";
  from?: string | null;
  to?: string | null;
  runningCommit?: string;
  error?: string;
  finishedAt: string;
};

export type UpdateStatus = {
  available: boolean;
  current: string | null;
  latest: string | null;
  checkedAt: string | null;
  updating: boolean;
  blockedReason: string | null;
  lastUpdate: LastUpdate | null;
};

export type Health = { ok: boolean; commit?: string | null };

export type ApplyResult = { ok: true; from: string; to: string } | { ok: false; reason: string };

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const res = await fetch("/api/update/status");
  if (!res.ok) throw new Error(`GET /api/update/status responded ${res.status}`);
  return res.json();
}

/** Throws while the server is down mid-update; callers treat that as
 * "not back yet", not as an error. */
export async function getHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`GET /api/health responded ${res.status}`);
  return res.json();
}

export async function applyUpdate(): Promise<ApplyResult> {
  const res = await fetch("/api/update/apply", { method: "POST" });
  const body = await res.json().catch(() => null);
  if (res.status === 202) return { ok: true, from: body.from, to: body.to };
  return { ok: false, reason: (body && typeof body.error === "string" && body.error) || "The update couldn't start." };
}
