// Question bank generation (SPEC.md section 5's "Question banks"): the one
// background model turn that fills questionBank.js's storage for a
// subject's topics. Same one-shot, non-interactive `claude -p` shape as
// topicExtraction.js, and deliberately reuses that module's posture over
// liveSession.js's — this turn, unlike a Live question, IS grounded in the
// user's own uploaded material (liveSession.js's header comment calls this
// out explicitly as the thing it does NOT do), so it needs the same
// Read-only-these-exact-paths / hard `--disallowedTools` deny list
// topicExtraction.js uses, not liveSession.js's "deny every tool" shape.
//
// Known v1 simplification, worth revisiting once it matters: there's no
// per-topic record of which content file(s) a topic actually came from, so
// every topic in a subject is grounded in the SAME bounded slice of that
// subject's material (the first `batchFiles` batch) rather than whichever
// files actually cover it. Good enough for a subject whose material fits
// in one batch (the common case so far); a subject with enough material to
// need multiple batches will under-ground topics that came from a later
// batch until file-to-topic provenance exists.

import { promises as fs } from "node:fs";
import { runCommand } from "./processUtil.js";
import { listContent, parsedFilePath } from "./content.js";
import { batchFiles } from "./topicExtraction.js";
import { listTopicsNeedingBank, markBankGenerated } from "./topics.js";
import { addBankQuestions, QUESTION_TYPES, DIFFICULTIES } from "./questionBank.js";

const DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "mcp__*"];

/** Topics asked about in a single turn. Keeps one turn's reply (several
 * questions per topic, each with a model answer/rubric) from growing
 * unbounded the way a huge multi-topic subject otherwise would. */
export const MAX_TOPICS_PER_BATCH = 4;

/** Questions requested per topic per generation pass — "several questions
 * of varied types and angles" (SPEC.md section 5), not meant to exhaust
 * every possible angle in one pass; a later top-up (triggered by a Ready
 * session draining a topic, not yet built) can add more. */
export const QUESTIONS_PER_TOPIC = 4;

const MAX_PROMPT_CHARS = 1000;
const MAX_ANSWER_CHARS = 2000;
const MAX_RUBRIC_POINTS = 6;
const MAX_RUBRIC_POINT_CHARS = 200;
const MAX_MISCONCEPTIONS = 4;
const MAX_CHOICE_CHARS = 200;
const MAX_REPLY_CHARS = 400_000;

// Generous relative to topicExtraction's 180s: one turn here reads the
// same kind of material AND has to compose several full questions (with
// model answers and rubrics) per topic rather than just naming topics.
const TURN_TIMEOUT_MS = 240_000;

// Types that are self-graded against a rubric (SPEC.md section 5) rather
// than auto-graded locally — these need a real, non-empty rubric; the two
// auto-graded types (multiple_choice, cloze) are graded from their own
// answer-key fields instead, so a rubric is a nice-to-have, not required.
const SELF_GRADED_TYPES = QUESTION_TYPES.filter((t) => t !== "multiple_choice" && t !== "cloze");

const TAGGED_FENCE_RE = /```json\s+athena-question-bank\s*\n([\s\S]*?)```/g;
const PLAIN_FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;

/**
 * The prompt for one batch of topics, grounded in one batch of files (may
 * be empty — a topic added without any readable source material still
 * gets a bank, just from the model's own knowledge of the topic name).
 * Pure, exported for its own test.
 */
export function buildBankPrompt({ subjectName, topics, files, questionsPerTopic = QUESTIONS_PER_TOPIC }) {
  const filesBlock = files.length
    ? `Ground your questions in this material — read these exact paths, and nothing else, using the Read tool:\n${files
        .map((f) => `- ${f.absolutePath}`)
        .join("\n")}`
    : `No uploaded material is available for these topics yet — use your own knowledge of each topic name/notes instead.`;

  const topicsBlock = topics
    .map((t, i) => `${i + 1}. "${t.name}"${t.notes ? ` — ${t.notes}` : ""}`)
    .join("\n");

  return `This is a one-shot background task, not a conversation. Don't ask questions back; just produce the question bank below and reply once.

Subject: ${subjectName}

${filesBlock}

Write a question bank for these topics:
${topicsBlock}

For EACH topic above, write exactly ${questionsPerTopic} questions, varied in type and angle (not ${questionsPerTopic} versions of the same question) — pick from: ${QUESTION_TYPES.join(", ")}. For every question, give:
- "prompt": the question text shown to the user (for "cloze", include a blank in the text, e.g. "_____").
- "difficulty": one of intro, medium, hard.
- "modelAnswer": a correct, complete answer.
- "rubric": the key points a correct answer should hit, as a short list — required for every type except multiple_choice/cloze (those are graded automatically from their own answer key below, not a rubric).
- "misconceptions": common wrong answers or mix-ups for this question, as a short list (can be empty if none are notable).

Additionally, for a "multiple_choice" question also give "choices" (2-6 short options) and "correctIndex" (the 0-based index of the right one in "choices"). For a "cloze" question also give "clozeAnswer" (the exact text that fills the blank).

Finish your reply with exactly one fenced block in this exact form, and nothing after it:

\`\`\`json athena-question-bank
{
  "topics": [
    {
      "topicName": "<exactly one of the topic names given above>",
      "questions": [
        {
          "type": "<one of: ${QUESTION_TYPES.join(", ")}>",
          "prompt": "<question text>",
          "difficulty": "<intro|medium|hard>",
          "modelAnswer": "<model answer>",
          "rubric": ["<key point>"],
          "misconceptions": ["<common mistake>"],
          "choices": ["<option>"],
          "correctIndex": 0,
          "clozeAnswer": "<exact blank-filling text>"
        }
      ]
    }
  ],
  "summary": "<one sentence on what was generated>"
}
\`\`\``;
}

function cappedStringArray(value, { maxCount, maxChars }) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, maxChars));
    if (out.length >= maxCount) break;
  }
  return out;
}

/**
 * Validates and normalizes one raw question from a reply. Returns `null`
 * (reject just this question, not the whole topic/reply) rather than
 * throwing — a reply is untrusted input, same posture as
 * topicExtraction.js's/liveSession.js's parsers, just applied per-question
 * instead of per-reply since one topic's bad question shouldn't cost its
 * siblings.
 */
function normalizeQuestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!QUESTION_TYPES.includes(raw.type)) return null;

  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return null;
  const modelAnswer = typeof raw.modelAnswer === "string" ? raw.modelAnswer.trim() : "";
  if (!modelAnswer) return null;

  const rubric = cappedStringArray(raw.rubric, { maxCount: MAX_RUBRIC_POINTS, maxChars: MAX_RUBRIC_POINT_CHARS });
  if (SELF_GRADED_TYPES.includes(raw.type) && rubric.length === 0) return null;

  const question = {
    type: raw.type,
    prompt: prompt.slice(0, MAX_PROMPT_CHARS),
    difficulty: DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : "medium",
    modelAnswer: modelAnswer.slice(0, MAX_ANSWER_CHARS),
    rubric,
    misconceptions: cappedStringArray(raw.misconceptions, { maxCount: MAX_MISCONCEPTIONS, maxChars: MAX_RUBRIC_POINT_CHARS }),
  };

  if (raw.type === "multiple_choice") {
    const choices = cappedStringArray(raw.choices, { maxCount: 6, maxChars: MAX_CHOICE_CHARS });
    if (choices.length < 2) return null;
    if (!Number.isInteger(raw.correctIndex) || raw.correctIndex < 0 || raw.correctIndex >= choices.length) return null;
    question.choices = choices;
    question.correctIndex = raw.correctIndex;
  }

  if (raw.type === "cloze") {
    const clozeAnswer = typeof raw.clozeAnswer === "string" ? raw.clozeAnswer.trim() : "";
    if (!clozeAnswer) return null;
    question.clozeAnswer = clozeAnswer.slice(0, MAX_ANSWER_CHARS);
  }

  return question;
}

/**
 * Extracts a bank-per-topic list from a turn's raw reply text. Never
 * throws. Preference order, most-specific first: the LAST correctly-tagged
 * fence, then the last plain fence, then the bare reply text — same
 * last-wins reasoning as topicExtraction.js's `parseExtractionReply` (a
 * reply that restates the format before filling it in isn't parsed from
 * its own example).
 */
export function parseBankReply(resultText) {
  const full = typeof resultText === "string" ? resultText : "";
  if (!full.trim()) return { ok: false, reason: "the reply was empty" };
  const text = full.length > MAX_REPLY_CHARS ? full.slice(-MAX_REPLY_CHARS) : full;

  const tagged = [...text.matchAll(TAGGED_FENCE_RE)].map((m) => m[1]).reverse();
  const plain = [...text.matchAll(PLAIN_FENCE_RE)].map((m) => m[1]).reverse();

  let data = null;
  for (const candidate of [...tagged, ...plain, text]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.topics)) {
        data = parsed;
        break;
      }
    } catch {
      // Not this candidate — keep looking.
    }
  }
  if (!data) return { ok: false, reason: "no readable question bank in the reply" };

  const topics = [];
  for (const rawTopic of data.topics) {
    const topicName = typeof rawTopic?.topicName === "string" ? rawTopic.topicName.trim() : "";
    if (!topicName) continue;
    const rawQuestions = Array.isArray(rawTopic.questions) ? rawTopic.questions : [];
    const questions = rawQuestions.map(normalizeQuestion).filter(Boolean);
    topics.push({ topicName, questions });
  }

  if (!topics.length) return { ok: false, reason: "the reply's topic list had no usable topics in it" };

  return { ok: true, topics, summary: typeof data.summary === "string" ? data.summary.slice(0, 300) : "" };
}

/** Test seam for the model call — same convention as
 * topicExtraction.js's `runExtractionTurn`. */
export async function runBankGenerationTurn(prompt, { env } = {}) {
  const result = await runCommand("claude", ["-p", "--disallowedTools", ...DENIED_TOOLS, "--", prompt], {
    timeoutMs: TURN_TIMEOUT_MS,
    env,
  });
  if (result.code !== 0) {
    throw new Error(`claude exited with code ${result.code}: ${result.stderr.slice(0, 300)}`);
  }
  return result.stdout;
}

// Same overlapping-trigger guard as topicExtraction.js's `inFlightSubjects`
// — a subject already being scanned simply skips a second concurrent
// call rather than racing it.
const inFlightSubjects = new Set();

/**
 * Scans a subject's topics that have never had an initial question bank
 * (`bankGeneratedAt` still null), runs one background turn per bounded
 * batch of topics, and stores whatever valid questions come back. A topic
 * is marked generated only once it has at least one valid question saved
 * for it — a topic the model skipped entirely, or returned with every
 * question rejected, stays unmarked so the next scan retries it, same
 * "don't silently lose it" posture as `scanSubjectForTopics`.
 */
export async function scanSubjectForBankGeneration(appDataDir, subjectId, { subjectName, runTurn = runBankGenerationTurn } = {}) {
  if (inFlightSubjects.has(subjectId)) {
    return { ok: true, skipped: true, topicsProcessed: 0, questionsAdded: 0, errors: [] };
  }
  inFlightSubjects.add(subjectId);
  try {
    const needingBank = await listTopicsNeedingBank(appDataDir, subjectId);
    if (!needingBank.length) {
      return { ok: true, skipped: false, topicsProcessed: 0, questionsAdded: 0, errors: [] };
    }

    const content = await listContent(appDataDir, subjectId);
    const availableFiles = [];
    for (const item of content) {
      const absolutePath = parsedFilePath(appDataDir, item);
      try {
        await fs.access(absolutePath);
      } catch {
        continue; // nothing parsed on disk yet for this item — just skip it as grounding material
      }
      availableFiles.push({ ...item, absolutePath });
    }
    // See the module header: every batch in this scan shares the same
    // first file batch as grounding, rather than per-topic provenance.
    const groundingFiles = batchFiles(availableFiles)[0] ?? [];

    const topicBatches = [];
    for (let i = 0; i < needingBank.length; i += MAX_TOPICS_PER_BATCH) {
      topicBatches.push(needingBank.slice(i, i + MAX_TOPICS_PER_BATCH));
    }

    const errors = [];
    let topicsProcessed = 0;
    let questionsAdded = 0;

    for (const batch of topicBatches) {
      const prompt = buildBankPrompt({ subjectName, topics: batch, files: groundingFiles });

      let replyText;
      try {
        replyText = await runTurn(prompt);
      } catch (err) {
        errors.push(`${batch.length} topic(s) not processed: ${String(err.message ?? err).slice(0, 200)}`);
        continue; // leave this batch's topics unmarked — retryable on the next scan
      }

      const parsed = parseBankReply(replyText);
      if (!parsed.ok) {
        errors.push(`${batch.length} topic(s) not processed: ${parsed.reason}`);
        continue;
      }

      const byName = new Map(parsed.topics.map((t) => [t.topicName.trim().toLowerCase(), t]));
      const generatedIds = [];
      for (const topic of batch) {
        const match = byName.get(topic.name.trim().toLowerCase());
        if (!match || !match.questions.length) {
          errors.push(`Topic "${topic.name}" not processed: the reply had no usable questions for it`);
          continue;
        }
        const added = await addBankQuestions(appDataDir, topic.id, topic.subjectId, match.questions);
        questionsAdded += added.length;
        generatedIds.push(topic.id);
      }
      if (generatedIds.length) {
        await markBankGenerated(appDataDir, generatedIds);
        topicsProcessed += generatedIds.length;
      }
    }

    return { ok: errors.length === 0, skipped: false, topicsProcessed, questionsAdded, errors };
  } finally {
    inFlightSubjects.delete(subjectId);
  }
}
