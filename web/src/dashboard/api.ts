// Thin fetch wrappers for the dashboard's subject data (server/src/routes/subjects.js).
// Kept separate from Dashboard.tsx so the request/response shape can be
// unit-tested without rendering any component, same split setup/api.ts uses.

export type Subject = { id: string; name: string; archived: boolean; createdAt: string };

export type SubjectSummary = {
  masteryCounts: { new: number; learning: number; mastered: number };
  dueCount: number;
  bankSize: number;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} responded ${res.status}`);
  return res.json();
}

export function listSubjects(): Promise<Subject[]> {
  return getJson("/api/subjects");
}

export function getSubjectSummary(id: string): Promise<SubjectSummary> {
  return getJson(`/api/subjects/${id}/summary`);
}
