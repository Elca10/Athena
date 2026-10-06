// Live mode's first question (SPEC.md section 5: "Athena generates custom
// questions ... in real time in a Claude Code session"). One `claude -p`
// turn, same one-shot shape as topicExtraction.js — not a persistent
// interactive CLI session: later turns (follow-ups, grading escalation,
// not yet built) will each be their own one-shot call, replaying whatever
// the session record has stored so far as context, so the server — not a
// long-lived child process — owns conversation state. This keeps every
// model call scriptable and testable in isolation, the same reasoning
// that shaped topicExtraction.js's turn.
//
// Scope of this module: only the very first question a Live session shows,
// generated from a topic's name/notes alone (no file reads — grounding a
// question in the user's own uploaded material is the question-bank
// generation path, Ready mode's job, not yet built). Security posture
// mirrors topicExtraction.js: a hard `--disallowedTools` deny list rather
// than a prompt-level request, even though this turn never needed file
// access in the first place.

import { runCommand } from "./processUtil.js";
import { getSession, setCurrentQuestion } from "./sessions.js";
import { getSubject } from "./subjects.js";
import { getTopicById } from "./topics.js";

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

// A single short model reply — generous relative to topicExtraction's
// 180s (which also reads files), stingy enough a hung CLI doesn't block a
// session's "Active" card forever.
const TURN_TIMEOUT_MS = 60_000;

const TAGGED_FENCE_RE = /```json\s+athena-live-question\s*\n([\s\S]*?)```/g;
const PLAIN_FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;

/**
 * The prompt for one first question. Pure, exported for its own test.
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
 * Generates a Live session's first question and stores it, moving the
 * session to "waiting" (SPEC.md section 4). Validation errors (bad
 * session id, wrong mode, a question already generated, no topics to ask
 * about) throw — these are caller mistakes, not a recoverable model-call
 * outcome. A model-call failure or an unparseable reply is NOT thrown:
 * it's returned as `{ok: false, reason}` and the session is left
 * untouched (still "active", no question) so a retry can be attempted
 * later without the session having silently moved on — same reasoning as
 * `scanSubjectForTopics` leaving a failed batch's files unprocessed.
 */
export async function generateFirstLiveQuestion(appDataDir, sessionId, { runTurn = runFirstQuestionTurn } = {}) {
  const session = await getSession(appDataDir, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.mode !== "live") throw new Error(`generateFirstLiveQuestion only applies to live-mode sessions: ${sessionId}`);
  if (session.currentQuestion) throw new Error(`Session already has a current question: ${sessionId}`);
  if (!session.topicIds.length) throw new Error(`Session has no topics to ask about: ${sessionId}`);

  const topicId = session.topicIds[0];
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
