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
