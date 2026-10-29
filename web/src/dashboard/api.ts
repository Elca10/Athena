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
  /** The soonest deadline on or after today (server/src/deadlines.js). */
  nextDeadline?: { id: string; title: string; date: string; studying: boolean } | null;
};

export type SessionStatus = "active" | "waiting" | "completed";
export type SessionMode = "live" | "ready" | "hybrid";
/** "exam": the user already knows the material, so no intro questions (issue #18). */
export type SessionFocus = "learn" | "exam";

/** How each mode is named on screen. Hybrid (issue #16): Ready's
 * pre-generated questions, with written answers graded by Athena. */
export const MODE_LABELS: Record<SessionMode, string> = { live: "Live", ready: "Ready", hybrid: "Hybrid" };

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
  /** The files this session was limited to; empty or absent means all content. */
  contentIds?: string[];
  mode: SessionMode;
  /** Absent on sessions from before issue #18: same as "learn". */
  focus?: SessionFocus;
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

async function putJsonBody<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `PUT ${url} responded ${res.status}`));
  return res.json();
}

async function patchJsonBody<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `PATCH ${url} responded ${res.status}`));
  return res.json();
}

export function listSubjects({ includeArchived = false }: { includeArchived?: boolean } = {}): Promise<Subject[]> {
  return getJson(`/api/subjects${includeArchived ? "?includeArchived=true" : ""}`);
}

export function createSubject(name: string): Promise<Subject> {
  return postJsonBody("/api/subjects", { name });
}

export async function renameSubject(id: string, name: string): Promise<Subject> {
  const res = await fetch(`/api/subjects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Couldn't rename (${res.status})`));
  return res.json();
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
  { reviewAhead = false, contentIds, focus }: { reviewAhead?: boolean; contentIds?: string[]; focus?: SessionFocus } = {},
): Promise<Session> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subjectIds,
      mode,
      ...(reviewAhead ? { reviewAhead } : {}),
      ...(contentIds?.length ? { contentIds } : {}),
      ...(focus === "exam" ? { focus } : {}),
    }),
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
export type LiveAnswerResult =
  | { ok: true; session: Session; milestone?: string | null }
  | { ok: false; reason: string };

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
// (`finalized: false`). In a Hybrid session those other types are graded
// by a model turn instead (`feedback` + `rating`), which can also fail
// with the same retryable `{ok: false, reason}` as /live/answer.
export type ReadyAnswerResult =
  | {
      ok: true;
      finalized: true;
      isCorrect: boolean;
      correctAnswer: string | null;
      modelAnswer: string | null;
      /** Deterministic, persona-consistent one-liner (readySession.js's
       * `confidenceMismatchNote`) when stated confidence and correctness
       * clearly mismatch; null otherwise. No model call involved. */
      mismatchNote?: string | null;
      /** Deterministic milestone applause (readySession.js, `subjectSummary.js`'s
       * `justReachedMastered`) when this answer just moved the topic to
       * mastered; null otherwise. */
      milestone?: string | null;
      session: Session;
    }
  | {
      ok: true;
      finalized: true;
      feedback: string;
      rating: "again" | "hard" | "good" | "easy";
      modelAnswer: string | null;
      milestone?: string | null;
      session: Session;
    }
  | { ok: true; finalized: false; modelAnswer: string; rubric: string[]; misconceptions: string[]; session: Session }
  | { ok: false; reason: string };

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
): Promise<{ ok: true; finalized: true; mismatchNote?: string | null; milestone?: string | null; session: Session }> {
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

/** Names of the topics that came only from this item, so removing it
 * would remove them too (issue #6). */
export async function getRemovalPreview(subjectId: string, contentId: string): Promise<{ topics: string[] }> {
  return getJson(`/api/subjects/${subjectId}/content/${contentId}/removal`);
}

// Mirrors topics.js's record shape (server/src/topics.js). `fsrs.state` is
// ts-fsrs's State enum (New=0, Learning=1, Review=2, Relearning=3) — see
// topicMastery.ts's classifyTopicMastery, which mirrors subjectSummary.js's
// own classifyMastery so a topic's badge there always agrees with its
// subject card's new/learning/mastered counts. (Deliberately NOT a pure
// helper in this file: every panel's test does a blanket `vi.mock("./api")`,
// which auto-mocks every export here — a pure classifier would silently
// come back `undefined` in those tests instead of running for real.)
export type Topic = {
  id: string;
  subjectId: string;
  name: string;
  notes: string;
  createdAt: string;
  fsrs: { state: number } & Record<string, unknown>;
  bankGeneratedAt: string | null;
};

export function listTopics(subjectId: string): Promise<Topic[]> {
  return getJson(`/api/subjects/${subjectId}/topics`);
}

// GET /api/subjects/:id/reflections (server/src/routes/reflections.js) —
// read-only; reflections are written through /api/sessions/:id/reflection.
export function listReflections(subjectId: string): Promise<Reflection[]> {
  return getJson(`/api/subjects/${subjectId}/reflections`);
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
  /** Topics still without practice questions: they're written a chunk at
   * a time (issue #10), the next chunk after each Ready session. */
  remaining?: number;
  errors: string[];
};

/** Writes practice questions for the next chunk of the subject's topics,
 * or for exactly `topicIds` (a session's own). */
export async function scanBank(subjectId: string, { topicIds }: { topicIds?: string[] } = {}): Promise<BankScanResult> {
  if (!topicIds) return postJson(`/api/subjects/${subjectId}/topics/bank/scan`);
  const res = await fetch(`/api/subjects/${subjectId}/topics/bank/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topicIds }),
  });
  if (!res.ok) throw new Error(`POST /api/subjects/${subjectId}/topics/bank/scan responded ${res.status}`);
  return res.json();
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

// Deadlines (server/src/deadlines.js, routes/deadlines.js). `date` is a
// local calendar date, YYYY-MM-DD. An empty `topicIds` means the deadline
// covers the whole subject. `studying` is whether the schedule paces for it.
export type Deadline = {
  id: string;
  subjectId: string;
  title: string;
  date: string;
  topicIds: string[];
  studying: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type DeadlineInput = { title: string; date: string; topicIds: string[]; studying?: boolean };

export function listDeadlines(subjectId: string): Promise<Deadline[]> {
  return getJson(`/api/subjects/${subjectId}/deadlines`);
}

export function createDeadline(subjectId: string, input: DeadlineInput): Promise<Deadline> {
  return postJsonBody(`/api/subjects/${subjectId}/deadlines`, input);
}

export async function updateDeadline(subjectId: string, id: string, changes: Partial<DeadlineInput>): Promise<Deadline> {
  const res = await fetch(`/api/subjects/${subjectId}/deadlines/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Couldn't save that deadline (${res.status}).`));
  return res.json();
}

export function deleteDeadline(subjectId: string, id: string): Promise<void> {
  return deleteJson(`/api/subjects/${subjectId}/deadlines/${id}`);
}

// Canvas calendar-feed import (server/src/canvasFeed.js). The feed URL is
// a secret and never comes back from the server: status names the host only.
export type CanvasFeedStatus = { connected: boolean; host: string | null };

export type CanvasFeedEvent = {
  uid: string;
  title: string;
  course: string | null;
  date: string;
  /** The deadline this event was already added as, if any. */
  imported: { deadlineId: string; subjectId: string; title: string; date: string } | null;
  /** Canvas's title or date no longer matches that deadline. */
  changed: boolean;
  suggestedSubjectId: string | null;
};

export function getCanvasFeedStatus(): Promise<CanvasFeedStatus> {
  return getJson("/api/canvas-feed");
}

export function connectCanvasFeed(url: string): Promise<CanvasFeedStatus> {
  return putJsonBody("/api/canvas-feed", { url });
}

export function disconnectCanvasFeed(): Promise<void> {
  return deleteJson("/api/canvas-feed");
}

export async function listCanvasFeedEvents(): Promise<CanvasFeedEvent[]> {
  const res = await fetch("/api/canvas-feed/events");
  if (!res.ok) throw new Error(await errorMessage(res, `Couldn't load your Canvas events (${res.status}).`));
  return res.json();
}

export function importCanvasFeedEvents(subjectId: string, uids: string[]): Promise<{ added: Deadline[]; skipped: number }> {
  return postJsonBody("/api/canvas-feed/import", { subjectId, uids });
}

// The suggested schedule (server/src/schedule.js, routes/schedule.js).
// Weekdays are 0 = Sunday ... 6 = Saturday.
export type Availability = { weekdays: number[]; minutesPerDay: number };

export type ScheduleBlock = {
  id: string;
  topicId: string;
  topicName: string;
  subjectId: string;
  subjectName: string;
  date: string;
  status: "planned" | "done";
  /** Who marked it done: a real study session, or the user. */
  doneBy: "session" | "you" | null;
  moved: boolean;
  /** The user moved or marked it; the schedule leaves it alone. */
  byYou: boolean;
  reason: "due" | "deadline" | "you" | "studied";
  deadline: { id: string; title: string; date: string } | null;
};

export type ScheduleDay = {
  date: string;
  weekday: number;
  available: boolean;
  blocks: ScheduleBlock[];
  deadlines: { id: string; title: string; subjectId: string; subjectName: string; studying: boolean }[];
};

export type Schedule = {
  today: string;
  horizonDays: number;
  availability: Availability;
  minutesPerBlock: number;
  blocksPerDay: number;
  days: ScheduleDay[];
  unscheduled: { deadlineId: string; title: string; date: string; subjectId: string; subjectName: string; topicCount: number }[];
};

export function getSchedule(): Promise<Schedule> {
  return getJson("/api/schedule");
}

export async function saveAvailability(availability: Availability): Promise<Schedule> {
  const res = await fetch("/api/schedule/availability", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(availability),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Couldn't save your study days (${res.status}).`));
  return res.json();
}

export type BlockAction = "done" | "undone" | "move" | "delete" | "restore";

/** `changed`: the block wasn't on the schedule any more (another tab, a
 * session, midnight); `schedule` is then the current one to show. */
export type BlockActionResult =
  | { ok: true; schedule: Schedule }
  | { ok: false; error: string; schedule?: Schedule };

export async function scheduleBlockAction(blockId: string, action: BlockAction, toDate?: string): Promise<BlockActionResult> {
  const res = await fetch(`/api/schedule/blocks/${encodeURIComponent(blockId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toDate ? { toDate } : {}),
  });
  const body = await res.json().catch(() => null);
  if (res.ok && body) return { ok: true, schedule: body };
  const error = (body && typeof body.error === "string" && body.error) || `That didn't work (${res.status}). Try again.`;
  return { ok: false, error, schedule: body?.schedule };
}

// Several blocks to one day at once (issue #22): all move, or none do.
export async function moveScheduleBlocks(ids: string[], toDate: string): Promise<BlockActionResult> {
  const res = await fetch("/api/schedule/blocks/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, toDate }),
  });
  const body = await res.json().catch(() => null);
  if (res.ok && body) return { ok: true, schedule: body };
  const error = (body && typeof body.error === "string" && body.error) || `That didn't work (${res.status}). Try again.`;
  return { ok: false, error, schedule: body?.schedule };
}

// Mirrors server/src/bigIdeas.js's record shape (SPEC-v2.md section 3's
// structure-building row / SPEC.md section 6: a per-subject "big ideas"
// summary the user writes and revises themselves — no model call anywhere
// on this path). `history` is oldest-first, capped server-side.
export type BigIdeasHistoryEntry = { text: string; updatedAt: string };
export type BigIdeas = {
  subjectId: string;
  text: string;
  updatedAt: string | null;
  history: BigIdeasHistoryEntry[];
};

export function getBigIdeas(subjectId: string): Promise<BigIdeas> {
  return getJson(`/api/subjects/${subjectId}/big-ideas`);
}

export function setBigIdeas(subjectId: string, text: string): Promise<BigIdeas> {
  return putJsonBody(`/api/subjects/${subjectId}/big-ideas`, { text });
}

// Mirrors server/src/settings.js. Currently just the one toggle: whether
// the end-of-session reflection is followed by a short "revise your big
// ideas?" prompt. Off by default.
export type Settings = { bigIdeasPromptEnabled: boolean };

export function getSettings(): Promise<Settings> {
  return getJson(`/api/settings`);
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return patchJsonBody(`/api/settings`, patch);
}
