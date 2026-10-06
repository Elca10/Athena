// Live mode's questions (SPEC.md section 5: "Athena generates custom
// questions ... in real time in a Claude Code session"). One `claude -p`
// turn per question, same one-shot shape as topicExtraction.js — not a
// persistent interactive CLI session: each question (and each grading
// turn) is its own one-shot call, replaying whatever the session record
// has stored so far as context, so the server — not a long-lived child
// process — owns conversation state. This keeps every model call
// scriptable and testable in isolation, the same reasoning that shaped
// topicExtraction.js's turn.
//
// This module also grades a Live answer once the user submits one
// (`submitLiveAnswer`, below): SPEC.md section 5's "Grading without a
// model call" describes Ready mode's near-zero-model-usage path (a
// pre-built bank rubric the user self-grades against) — Live mode has no
// bank and no rubric, so there's nothing to self-grade against. Grading a
// Live answer is itself one more real-time model turn, the same "costs
// more model time by design" tradeoff that's already true of Live mode's
// question generation (section 5: Live "uses more model time; the user
// chooses it when they want that"). The model is asked to pick the FSRS
// rating directly (again/hard/good/easy) rather than a finer-grained
// key-points breakdown, since there's no rubric structure to hang that on
// here — Ready mode's bank-backed self-grading is where that finer
// breakdown belongs.
//
// Scope of this module: walking a Live session through its `topicIds` one
// at a time — each question generated from a topic's name/notes alone (no
// file reads — grounding a question in the user's own uploaded material is
// the question-bank generation path, Ready mode's job, not yet built) —
// plus grading the user's answer to each one. A session's `history`
// (sessions.js) is the record of which topics have already been asked;
// once every `topicIds` entry has a matching history entry, the session is
// naturally finished and this module ends it rather than generating
// another question. Security posture mirrors topicExtraction.js: a hard
// `--disallowedTools` deny list rather than a prompt-level request, even
// though neither turn ever needed file access in the first place.

import { runCommand } from "./processUtil.js";
import { getSession, setCurrentQuestion, recordAnswer, endSession } from "./sessions.js";
import { getSubject } from "./subjects.js";
import { getTopicById, recordTopicReview } from "./topics.js";
import { RATINGS } from "./scheduler.js";

/** This turn needs no tools at all — it answers from the topic name/notes
 * given in the prompt, so every tool is denied rather than just the
 * obviously dangerous ones. */
const DENIED_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "mcp__*"];

/** SPEC.md section 5's question-type list, minus the two (multiple choice,
 * cloze) that need auto-gradable structured answer data this module
 * doesn't ask the model for — those belong to question-bank generation,
 * which stores a real rubric/answer key alongside them. A Live first
 * question is always one of the free-form types, self-graded by the user
 * (section 5: "the user answers first, then sees the model answer"). */
export const QUESTION_TYPES = ["free_recall", "explain_why", "apply", "compare_contrast", "short_answer", "worked_problem"];

export const DIFFICULTIES = ["intro", "medium", "hard"];

const MAX_PROMPT_CHARS = 2000;
const MAX_REPLY_CHARS = 400_000;
const MAX_ANSWER_CHARS = 4000;
const MAX_FEEDBACK_CHARS = 2000;

// A single short model reply — generous relative to topicExtraction's
// 180s (which also reads files), stingy enough a hung CLI doesn't block a
// session's "Active" card forever.
const TURN_TIMEOUT_MS = 60_000;

const TAGGED_FENCE_RE = /```json\s+athena-live-question\s*\n([\s\S]*?)```/g;
const TAGGED_FEEDBACK_FENCE_RE = /```json\s+athena-live-feedback\s*\n([\s\S]*?)```/g;
const PLAIN_FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;

/**
 * Picks the next topic a Live session should ask about: the first entry
 * in `topicIds` with no matching `history` entry yet, preserving
 * `sessionBuilder.js`'s interleaving order. Returns `null` once every
 * topic has been asked — the caller's signal to end the session rather
 * than generate another question. Pure, exported for its own test.
 */
export function pickNextTopicId(topicIds, history) {
  const asked = new Set((history ?? []).map((entry) => entry.topicId));
  return topicIds.find((id) => !asked.has(id)) ?? null;
}

/**
 * The prompt for one question. Pure, exported for its own test.
 * `isNewTopic` drives section 6's Generation principle: a topic the user
 * has never reviewed gets an attempt-first framing ("what do you think
 * X is / how would you approach it") rather than assuming prior
 * explanation; a topic that's been reviewed before can ask a harder,
 * more specific angle (recall, apply, compare).
 */
export function buildFirstQuestionPrompt({ subjectNames, topic, isNewTopic }) {
  const subjectLine = subjectNames.length ? subjectNames.join(", ") : "an unspecified subject";
  const notesLine = topic.notes ? `\nNotes on what this topic covers: ${topic.notes}` : "";
  const framingLine = isNewTopic
    ? `The user has never been reviewed on this topic before. Per this app's "generation" study principle, do NOT explain it first — ask a question that invites an attempt or a prediction before any explanation (e.g. "what do you think X means", "how would you approach Y"), pitched at someone encountering it for the first time.`
    : `The user has reviewed this topic before. Ask a question that genuinely tests recall or application, not just recognition — vary the angle from a plain definition.`;

  return `This is a one-shot background task, not a conversation. Don't ask questions back; just produce the one study question below and reply once.

Subject: ${subjectLine}
Topic to ask about: "${topic.name}"${notesLine}

${framingLine}

The question must be answerable from memory with no tools, in a few sentences to a short paragraph — not multiple choice, not fill-in-the-blank. Pick whichever of these types fits best: ${QUESTION_TYPES.join(", ")}. Pick a difficulty of intro, medium, or hard.

Finish your reply with exactly one fenced block in this exact form, and nothing after it:

\`\`\`json athena-live-question
{
  "prompt": "<the question text shown to the user>",
  "type": "<one of: ${QUESTION_TYPES.join(", ")}>",
  "difficulty": "<intro|medium|hard>"
}
\`\`\``;
}

/**
 * Extracts the question from a turn's raw reply text. Never throws — the
 * reply is untrusted input, same posture as topicExtraction.js's
 * `parseExtractionReply`.
 *
 * Preference order, most-specific first: the LAST correctly-tagged fence,
 * then the last plain fence, then the bare reply text — last rather than
 * first so a reply that restates the format before filling it in isn't
 * parsed from its own example.
 */
export function parseFirstQuestionReply(resultText) {
  const full = typeof resultText === "string" ? resultText : "";
  if (!full.trim()) return { ok: false, reason: "the reply was empty" };
  const text = full.length > MAX_REPLY_CHARS ? full.slice(-MAX_REPLY_CHARS) : full;

  const tagged = [...text.matchAll(TAGGED_FENCE_RE)].map((m) => m[1]).reverse();
  const plain = [...text.matchAll(PLAIN_FENCE_RE)].map((m) => m[1]).reverse();

  let data = null;
  for (const candidate of [...tagged, ...plain, text]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && typeof parsed.prompt === "string") {
        data = parsed;
        break;
      }
    } catch {
      // Not this candidate — keep looking.
    }
  }
  if (!data) return { ok: false, reason: "no readable question in the reply" };

  const prompt = data.prompt.trim();
  if (!prompt) return { ok: false, reason: "the reply's question prompt was blank" };
  if (!QUESTION_TYPES.includes(data.type)) {
    return { ok: false, reason: `the reply's question type was not one of ${QUESTION_TYPES.join(", ")}: ${JSON.stringify(data.type)}` };
  }

  return {
    ok: true,
    question: {
      prompt: prompt.slice(0, MAX_PROMPT_CHARS),
      type: data.type,
      // Difficulty is advisory metadata, not core content — default
      // rather than reject the whole question over it.
      difficulty: DIFFICULTIES.includes(data.difficulty) ? data.difficulty : "medium",
    },
  };
}

/**
 * Test seam for the model call — same convention as topicExtraction.js's
 * `runExtractionTurn`: `env` defaults to the full inherited environment
 * (so a real call finds the real `claude` on PATH) but is overridable to
 * a scratch PATH, so this module's own test never finds the real CLI.
 */
export async function runFirstQuestionTurn(prompt, { env } = {}) {
  const result = await runCommand("claude", ["-p", "--disallowedTools", ...DENIED_TOOLS, "--", prompt], {
    timeoutMs: TURN_TIMEOUT_MS,
    env,
  });
  if (result.code !== 0) {
    throw new Error(`claude exited with code ${result.code}: ${result.stderr.slice(0, 300)}`);
  }
  return result.stdout;
}

/**
 * Generates a Live session's next question and stores it, moving the
 * session to "waiting" (SPEC.md section 4) — the first call for a fresh
 * session and every subsequent call after an answer's been recorded both
 * go through here, `pickNextTopicId` deciding which topic (if any) is
 * next. Once every `topicIds` entry already has a `history` entry, there
 * is nothing left to ask: rather than erroring, the session is ended
 * (SPEC.md section 4's "Completed" — a Live session finishes on its own
 * once it's worked through its topics, the same way a Ready session isn't
 * expected to need an explicit end for running out of due topics either)
 * and returned as `{ok: true, done: true, session}`. Validation errors
 * (bad session id, wrong mode, a question already generated, no topics at
 * all) throw — these are caller mistakes, not a recoverable model-call
 * outcome. A model-call failure or an unparseable reply is NOT thrown:
 * it's returned as `{ok: false, reason}` and the session is left
 * untouched (still "active", no question) so a retry can be attempted
 * later without the session having silently moved on — same reasoning as
 * `scanSubjectForTopics` leaving a failed batch's files unprocessed.
 */
export async function generateNextLiveQuestion(appDataDir, sessionId, { runTurn = runFirstQuestionTurn } = {}) {
  const session = await getSession(appDataDir, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.mode !== "live") throw new Error(`generateNextLiveQuestion only applies to live-mode sessions: ${sessionId}`);
  if (session.currentQuestion) throw new Error(`Session already has a current question: ${sessionId}`);
  if (!session.topicIds.length) throw new Error(`Session has no topics to ask about: ${sessionId}`);

  const topicId = pickNextTopicId(session.topicIds, session.history);
  if (topicId === null) {
    const ended = await endSession(appDataDir, sessionId);
    return { ok: true, done: true, session: ended };
  }
  const topic = await getTopicById(appDataDir, topicId);
  if (!topic) throw new Error(`Topic not found: ${topicId}`);

  const subjectNames = [];
  for (const subjectId of session.subjectIds) {
    const subject = await getSubject(appDataDir, subjectId);
    if (subject) subjectNames.push(subject.name);
  }

  const isNewTopic = (topic.fsrs?.reps ?? 0) === 0;
  const prompt = buildFirstQuestionPrompt({ subjectNames, topic, isNewTopic });

  let replyText;
  try {
    replyText = await runTurn(prompt);
  } catch (err) {
    return { ok: false, reason: String(err.message ?? err).slice(0, 300) };
  }

  const parsed = parseFirstQuestionReply(replyText);
  if (!parsed.ok) return parsed;

  const question = {
    topicId: topic.id,
    subjectId: topic.subjectId,
    ...parsed.question,
    askedAt: new Date().toISOString(),
  };
  const updated = await setCurrentQuestion(appDataDir, sessionId, question);
  return { ok: true, session: updated };
}

/**
 * The prompt for grading one Live answer. Pure, exported for its own
 * test. Asks the model to pick an FSRS rating directly (see the module
 * comment above for why) rather than a finer key-points breakdown.
 */
export function buildGradingPrompt({ subjectNames, topic, question, answerText }) {
  const subjectLine = subjectNames.length ? subjectNames.join(", ") : "an unspecified subject";
  const notesLine = topic.notes ? `\nNotes on what this topic covers: ${topic.notes}` : "";

  return `This is a one-shot background task, not a conversation. Don't ask questions back; just grade the answer below and reply once.

Subject: ${subjectLine}
Topic: "${topic.name}"${notesLine}

Question asked (${question.type}, ${question.difficulty}): "${question.prompt}"

The user's answer: "${answerText}"

Grade this answer honestly and specifically: say exactly what's right, wrong, or missing. Don't soften a wrong or incomplete answer with unearned praise. Then pick exactly one rating for how this should affect spaced-repetition scheduling:
- "again": the answer was wrong, or shows the user doesn't actually know this yet.
- "hard": basically correct, but incomplete, hesitant, or clearly took real effort.
- "good": a solid, correct answer.
- "easy": correct, confident, and complete, with no real struggle.

Finish your reply with exactly one fenced block in this exact form, and nothing after it:

\`\`\`json athena-live-feedback
{
  "feedback": "<your specific feedback on this answer, a sentence or two to a short paragraph>",
  "rating": "<one of: again, hard, good, easy>"
}
\`\`\``;
}

/**
 * Extracts the grading result from a turn's raw reply text. Same
 * never-throws, last-fence-wins posture as `parseFirstQuestionReply`. The
 * rating is rejected outright (not defaulted) when invalid — unlike
 * difficulty on a question, it directly drives FSRS scheduling, so a
 * wrong guess here is worse than failing loudly and leaving the session
 * untouched for a retry.
 */
export function parseGradingReply(resultText) {
  const full = typeof resultText === "string" ? resultText : "";
  if (!full.trim()) return { ok: false, reason: "the reply was empty" };
  const text = full.length > MAX_REPLY_CHARS ? full.slice(-MAX_REPLY_CHARS) : full;

  const tagged = [...text.matchAll(TAGGED_FEEDBACK_FENCE_RE)].map((m) => m[1]).reverse();
  const plain = [...text.matchAll(PLAIN_FENCE_RE)].map((m) => m[1]).reverse();

  let data = null;
  for (const candidate of [...tagged, ...plain, text]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && typeof parsed.feedback === "string") {
        data = parsed;
        break;
      }
    } catch {
      // Not this candidate — keep looking.
    }
  }
  if (!data) return { ok: false, reason: "no readable grading result in the reply" };

  const feedback = data.feedback.trim();
  if (!feedback) return { ok: false, reason: "the reply's feedback was blank" };
  if (!RATINGS.includes(data.rating)) {
    return { ok: false, reason: `the reply's rating was not one of ${RATINGS.join(", ")}: ${JSON.stringify(data.rating)}` };
  }

  return { ok: true, feedback: feedback.slice(0, MAX_FEEDBACK_CHARS), rating: data.rating };
}

/** Test seam for the grading model call — same convention as
 * `runFirstQuestionTurn`. */
export async function runGradingTurn(prompt, { env } = {}) {
  const result = await runCommand("claude", ["-p", "--disallowedTools", ...DENIED_TOOLS, "--", prompt], {
    timeoutMs: TURN_TIMEOUT_MS,
    env,
  });
  if (result.code !== 0) {
    throw new Error(`claude exited with code ${result.code}: ${result.stderr.slice(0, 300)}`);
  }
  return result.stdout;
}

/**
 * Grades the user's answer to a Live session's current question, applies
 * the resulting FSRS rating to the topic, and records the answer in the
 * session's history (SPEC.md section 6's Calibration principle: a
 * confidence rating captured here, before grading, is the "predicted"
 * half a later dashboard will compare against actual outcomes). Validation
 * errors (bad session id, wrong mode, no current question, a malformed
 * answer/confidence) throw — caller mistakes, not a recoverable model-call
 * outcome. A model-call failure or unparseable/invalid-rating reply comes
 * back as `{ok: false, reason}` with the session and topic left untouched,
 * same posture as `generateNextLiveQuestion`.
 */
export async function submitLiveAnswer(appDataDir, sessionId, { answerText, confidence }, { runTurn = runGradingTurn } = {}) {
  const session = await getSession(appDataDir, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.mode !== "live") throw new Error(`submitLiveAnswer only applies to live-mode sessions: ${sessionId}`);
  if (!session.currentQuestion) throw new Error(`Session has no current question to answer: ${sessionId}`);

  const trimmedAnswer = typeof answerText === "string" ? answerText.trim() : "";
  if (!trimmedAnswer) throw new Error("answerText must be a non-empty string");
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    throw new Error("confidence must be an integer from 1 to 5");
  }

  const question = session.currentQuestion;
  const topic = await getTopicById(appDataDir, question.topicId);
  if (!topic) throw new Error(`Topic not found: ${question.topicId}`);

  const subjectNames = [];
  for (const subjectId of session.subjectIds) {
    const subject = await getSubject(appDataDir, subjectId);
    if (subject) subjectNames.push(subject.name);
  }

  const prompt = buildGradingPrompt({
    subjectNames,
    topic,
    question,
    answerText: trimmedAnswer.slice(0, MAX_ANSWER_CHARS),
  });

  let replyText;
  try {
    replyText = await runTurn(prompt);
  } catch (err) {
    return { ok: false, reason: String(err.message ?? err).slice(0, 300) };
  }

  const parsed = parseGradingReply(replyText);
  if (!parsed.ok) return parsed;

  await recordTopicReview(appDataDir, topic.id, parsed.rating);

  const entry = {
    ...question,
    answerText: trimmedAnswer,
    confidence,
    rating: parsed.rating,
    feedback: parsed.feedback,
    answeredAt: new Date().toISOString(),
  };
  const updated = await recordAnswer(appDataDir, sessionId, entry);
  return { ok: true, session: updated };
}
