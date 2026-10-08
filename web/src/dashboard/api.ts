// Thin fetch wrappers for the dashboard's subject data (server/src/routes/subjects.js).
// Kept separate from Dashboard.tsx so the request/response shape can be
// unit-tested without rendering any component, same split setup/api.ts uses.

export type Subject = { id: string; name: string; archived: boolean; createdAt: string };

export type SubjectSummary = {
  masteryCounts: { new: number; learning: number; mastered: number };
  dueCount: number;
  bankSize: number;
};

export type SessionStatus = "active" | "waiting" | "completed";

// Mirrors server/src/sessions.js's record shape — only the fields the
// dashboard's session columns actually display.
export type Session = {
  id: string;
  subjectIds: string[];
  mode: "live" | "ready";
  status: SessionStatus;
  endedAt: string | null;
  archived: boolean;
  currentQuestion: { prompt: string } | null;
  history: unknown[];
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} responded ${res.status}`);
  return res.json();
}

async function postJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`POST ${url} responded ${res.status}`);
  return res.json();
}

// Surfaces the server's own `{error: "..."}` message (routes/preferences.js)
// rather than a generic status-code string, since these are shown directly
// to the user (e.g. "too long"/"already at the maximum").
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

async function postJsonBody<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `POST ${url} responded ${res.status}`));
  return res.json();
}

async function deleteJson(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res, `DELETE ${url} responded ${res.status}`));
}

export function listSubjects({ includeArchived = false }: { includeArchived?: boolean } = {}): Promise<Subject[]> {
  return getJson(`/api/subjects${includeArchived ? "?includeArchived=true" : ""}`);
}

export function getSubjectSummary(id: string): Promise<SubjectSummary> {
  return getJson(`/api/subjects/${id}/summary`);
}

export function restoreSubject(id: string): Promise<Subject> {
  return postJson(`/api/subjects/${id}/restore`);
}

export function listSessions({ includeArchived = false }: { includeArchived?: boolean } = {}): Promise<Session[]> {
  return getJson(`/api/sessions${includeArchived ? "?includeArchived=true" : ""}`);
}

export function restoreSession(id: string): Promise<Session> {
  return postJson(`/api/sessions/${id}/restore`);
}

// Mirrors server/src/sessionStats.js's return shape exactly.
export type SessionStats = {
  sessionsThisWeek: number;
  questionsThisWeek: number;
  streakDays: number;
  accuracy: { correct: number; total: number; rate: number | null };
  calibration: { byConfidence: { confidence: number; total: number; correctRate: number | null }[] };
};

export function getSessionStats(): Promise<SessionStats> {
  return getJson(`/api/stats/sessions`);
}

// Mirrors server/src/usageStatus.js's return shape exactly.
export type UsageWindow = { status: "ok" | "warning" | "exceeded"; utilization: number; resetsAt?: number } | null;
export type UsageStatus = { fiveHour: UsageWindow; weekly: UsageWindow; checkedAt: number | null; error: string | null };

export function getUsageStatus(): Promise<UsageStatus> {
  return getJson(`/api/stats/usage`);
}

// Mirrors server/src/preferences.js's record shape (SPEC.md section 8,
// "Tune Athena").
export type Preference = { id: string; text: string; createdAt: string };

export function listPreferences(): Promise<Preference[]> {
  return getJson(`/api/preferences`);
}

export function addPreference(text: string): Promise<Preference> {
  return postJsonBody(`/api/preferences`, { text });
}

export function deletePreference(id: string): Promise<void> {
  return deleteJson(`/api/preferences/${id}`);
}
