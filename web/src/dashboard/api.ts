// Thin fetch wrappers for the dashboard's subject data (server/src/routes/subjects.js).
// Kept separate from Dashboard.tsx so the request/response shape can be
// unit-tested without rendering any component, same split setup/api.ts uses.

export type Subject = { id: string; name: string; archived: boolean; createdAt: string };

export type SubjectSummary = {
  masteryCounts: { new: number; learning: number; mastered: number };
  dueCount: number;
  bankSize: number;
  topicCount: number;
  contentCount: number;
  unreadContentCount: number;
};

export type SessionStatus = "active" | "waiting" | "completed";
export type SessionMode = "live" | "ready";

// Mirrors readySession.js's QUESTION_TYPES (questionBank.js) — the subset
// of fields `publicQuestionView` leaves on a served question. `choices`
// only appears for multiple_choice; `correctIndex`/`clozeAnswer` are never
// present here. `modelAnswer`/`rubric`/`misconceptions` are absent until
// the question has been answered — `pendingAnswer` is what marks that: a
// self-graded question the user has already answered but not yet
// self-graded (set by /ready/answer, kept by GET /, GET /:id, and
// /ready/question's own response from then on). That's also the shape a
// resumed Waiting session's `currentQuestion` arrives in, which is exactly
// why StudyFlow.tsx's `ReadySessionScreen` can resume straight into the
// self-grade step from it rather than needing a separate fetch.
export type QuestionType =
  | "free_recall"
  | "explain_why"
  | "apply"
  | "compare_contrast"
  | "short_answer"
  | "cloze"
  | "multiple_choice"
  | "worked_problem";

export type SessionQuestion = {
  topicId: string;
  subjectId: string;
  type: QuestionType;
  prompt: string;
  difficulty: string;
  choices?: string[];
  isGenerationQuestion?: boolean;
  askedAt: string;
  pendingAnswer?: { answerText: string; confidence: number; answeredAt: string };
  modelAnswer?: string;
  rubric?: string[];
  misconceptions?: string[];
};

// Mirrors server/src/sessions.js's record shape — only the fields the
// dashboard's session columns and study screens actually display.
export type Session = {
  id: string;
  subjectIds: string[];
  /** The topics this session covers, in order: one question each. */
  topicIds?: string[];
  mode: SessionMode;
  status: SessionStatus;
  endedAt: string | null;
  archived: boolean;
  currentQuestion: SessionQuestion | null;
  history: unknown[];
  reflectionPending?: boolean;
};

// Mirrors a Live session's `history` entry (liveSession.js's
// `submitLiveAnswer`) — the shape the just-answered question/feedback/
// rating live in, since /live/answer's own response has no separate
// top-level field for them the way /ready/answer does.
export type LiveHistoryEntry = SessionQuestion & {
  answerText: string;
  confidence: number;
  rating: "again" | "hard" | "good" | "easy";
  feedback: string;
  answeredAt: string;
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

export function createSubject(name: string): Promise<Subject> {
  return postJsonBody("/api/subjects", { name });
}

export function getSubjectSummary(id: string): Promise<SubjectSummary> {
  return getJson(`/api/subjects/${id}/summary`);
}

export function archiveSubject(id: string): Promise<Subject> {
  return postJson(`/api/subjects/${id}/archive`);
}

export function restoreSubject(id: string): Promise<Subject> {
  return postJson(`/api/subjects/${id}/restore`);
}

export function listSessions({ includeArchived = false }: { includeArchived?: boolean } = {}): Promise<Session[]> {
  return getJson(`/api/sessions${includeArchived ? "?includeArchived=true" : ""}`);
}

export function finishSession(id: string): Promise<{ reflection: boolean; session: Session }> {
  return postJson(`/api/sessions/${id}/finish`);
}

export function endSession(id: string): Promise<Session> {
  return postJson(`/api/sessions/${id}/end`);
}

export function archiveSession(id: string): Promise<Session> {
  return postJson(`/api/sessions/${id}/archive`);
}

export function restoreSession(id: string): Promise<Session> {
  return postJson(`/api/sessions/${id}/restore`);
}

export async function createSession(
  subjectIds: string[],
  mode: SessionMode,
  { reviewAhead = false }: { reviewAhead?: boolean } = {},
): Promise<Session> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subjectIds, mode, ...(reviewAhead ? { reviewAhead } : {}) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = (body && typeof body.error === "string" && body.error) || `POST /api/sessions responded ${res.status}`;
    throw Object.assign(new Error(message), { nothingDue: body?.nothingDue === true });
  }
  return res.json();
}

// Mirrors routes/sessions.js's /live/question shapes. `{ok: false, reason}`
// is a real, retryable model-call-or-unparseable-reply failure that leaves
// the session untouched (liveSession.js's `generateNextLiveQuestion` doc
// comment) — same discriminated-result posture as Ready's equivalent, but
// Live has no bank to come up empty, so there's no `noBank` case here.
export type LiveQuestionResult =
  | { ok: true; done: true; awaitingReflection: true; session: Session }
  | { ok: true; done?: false; session: Session }
  | { ok: false; reason: string };

export function generateNextLiveQuestion(sessionId: string): Promise<LiveQuestionResult> {
  return postJson(`/api/sessions/${sessionId}/live/question`);
}

// Mirrors routes/sessions.js's /live/answer shapes — grading is one more
// real-time model turn, so the same retryable `{ok: false, reason}` shape
// applies here too (liveSession.js's `submitLiveAnswer`).
export type LiveAnswerResult = { ok: true; session: Session } | { ok: false; reason: string };

export function submitLiveAnswer(
  sessionId: string,
  body: { answerText: string; confidence: number },
): Promise<LiveAnswerResult> {
  return postJsonBody(`/api/sessions/${sessionId}/live/answer`, body);
}

// Mirrors routes/sessions.js's /ready/question shapes. Discriminates on
// `ok` then `done` — the "no bank yet" outcome (`ok: false`) and the
// "every topic asked, now awaiting reflection" outcome (`done: true`) are
// both real, recoverable results, not request errors, same posture
// server/src/readySession.js documents on `generateNextReadyQuestion`.
export type ReadyQuestionResult =
  | { ok: true; done: true; awaitingReflection: true; session: Session; bankTopUps: unknown[] }
  | { ok: true; done?: false; session: Session }
  | { ok: false; noBank: true; topicId: string; reason: string };

export function generateNextReadyQuestion(sessionId: string): Promise<ReadyQuestionResult> {
  return postJson(`/api/sessions/${sessionId}/ready/question`);
}

// Mirrors readySession.js's `submitReadyAnswer` result: multiple_choice/
// cloze grade and finalize immediately (`finalized: true`); every other
// type instead reveals the model answer/rubric for a self-grade step next
// (`finalized: false`).
export type ReadyAnswerResult =
  | {
      ok: true;
      finalized: true;
      isCorrect: boolean;
      correctAnswer: string | null;
      modelAnswer: string | null;
      session: Session;
    }
  | { ok: true; finalized: false; modelAnswer: string; rubric: string[]; misconceptions: string[]; session: Session };

export function submitReadyAnswer(
  sessionId: string,
  body: { answerText?: string; selectedIndex?: number; confidence: number },
): Promise<ReadyAnswerResult> {
  return postJsonBody(`/api/sessions/${sessionId}/ready/answer`, body);
}

export type SelfGradeStatus = "got_it" | "partly" | "missed";

export function submitReadySelfGrade(
  sessionId: string,
  selfGrades: { status: SelfGradeStatus }[],
): Promise<{ ok: true; finalized: true; session: Session }> {
  return postJsonBody(`/api/sessions/${sessionId}/ready/self-grade`, { selfGrades });
}

// Mirrors reflection.js's REFLECTION_FIELDS — SPEC.md section 6's
// end-of-session prompt. Every field is individually optional; the server
// only rejects a submission where all four come back blank (that's what
// skipSessionReflection is for instead).
export type ReflectionAnswers = {
  learned?: string;
  surprised?: string;
  connects?: string;
  differently?: string;
};

export type Reflection = ReflectionAnswers & {
  id: string;
  sessionId: string;
  subjectIds: string[];
  createdAt: string;
};

export function submitSessionReflection(
  sessionId: string,
  answers: ReflectionAnswers,
): Promise<{ reflection: Reflection; session: Session }> {
  return postJsonBody(`/api/sessions/${sessionId}/reflection`, answers);
}

export function skipSessionReflection(sessionId: string): Promise<Session> {
  return postJson(`/api/sessions/${sessionId}/reflection/skip`);
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

// Mirrors server/src/content.js's record shape (SPEC.md section 7).
// `unreliablePages` is 1-based page numbers (PDF) or slide numbers
// (PPTX) that pageLooksUnreliable flagged as likely garbled/undecoded —
// [] for a clean upload or any plain-text item.
export type ContentItem = {
  id: string;
  subjectId: string;
  originalFilename: string;
  extension: string;
  source: "upload" | "paste";
  sizeBytes: number;
  addedAt: string;
  topicsExtractedAt: string | null;
  unreliablePages: number[];
};

export function listContent(subjectId: string): Promise<ContentItem[]> {
  return getJson(`/api/subjects/${subjectId}/content`);
}

// Plain-text formats (.txt/.md/.markdown): the browser reads the file as
// text and sends it verbatim.
export function uploadTextContent(subjectId: string, filename: string, text: string): Promise<ContentItem> {
  return postJsonBody(`/api/subjects/${subjectId}/content`, { filename, text });
}

// Binary formats (.pdf/.pptx): the file's raw bytes, filename in the
// query string (routes/content.js's /file route). They used to go as
// base64 inside JSON, which hit the size limit on big decks (issue #6).
export async function uploadBinaryContent(subjectId: string, file: File): Promise<ContentItem> {
  const res = await fetch(`/api/subjects/${subjectId}/content/file?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Upload failed (${res.status})`));
  return res.json();
}

/** Matches server/src/content.js's MAX_BINARY_CONTENT_BYTES. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function addPastedNotes(subjectId: string, text: string): Promise<ContentItem> {
  return postJsonBody(`/api/subjects/${subjectId}/content/notes`, { text });
}

// Mirrors topics.js's /scan response (routes/topics.js, topicExtraction.js):
// runs the one background model turn that reads newly-added content and
// seeds planned topics from it. `errors` is non-empty only when a batch's
// turn failed or came back unparseable — its files are left unprocessed,
// so a later scan retries them.
export type TopicScanResult = {
  ok: boolean;
  skipped: boolean;
  topicsAdded: number;
  filesProcessed: number;
  errors: string[];
};

export function removeContent(subjectId: string, contentId: string): Promise<void> {
  return deleteJson(`/api/subjects/${subjectId}/content/${contentId}`);
}

export function scanTopics(subjectId: string): Promise<TopicScanResult> {
  return postJson(`/api/subjects/${subjectId}/topics/scan`);
}

// Mirrors routes/topics.js's /bank/scan response (questionBankGeneration.js's
// `scanSubjectForBankGeneration`): the background model turn that fills in
// an initial question bank for any of the subject's topics that don't have
// one yet (SPEC.md section 5's "empty or thin banks" — this is the
// "generate now" action). `errors` is non-empty only when a batch's turn
// failed or came back unparseable; those topics are left unmarked, so a
// later scan retries them.
export type BankScanResult = {
  ok: boolean;
  skipped: boolean;
  topicsProcessed: number;
  questionsAdded: number;
  errors: string[];
};

export function scanBank(subjectId: string): Promise<BankScanResult> {
  return postJson(`/api/subjects/${subjectId}/topics/bank/scan`);
}

// Mirrors server/src/bugReport.js's two-step flow (SPEC.md section 10/
// 3.6): /preview never has a side effect — it just returns the exact
// `{title, body}` a confirmation screen shows, already redacted. /send
// takes exactly that previewed pair back (never the raw description
// again) so what gets filed can never diverge from what the user saw.
export type BugReportPreview = { title: string; body: string };
export type BugReportSendResult = { ok: true; url: string } | { ok: false; error: string };

export function previewBugReport(description: string): Promise<BugReportPreview> {
  return postJsonBody(`/api/bug-report/preview`, { description });
}

export function sendBugReport(preview: BugReportPreview): Promise<BugReportSendResult> {
  return postJsonBody(`/api/bug-report/send`, preview);
}
