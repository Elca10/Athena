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
// Grounding (issue #10): each topic is grounded in the file(s) it was
// found in (topics.js's `sourceContentIds`), and topics that share files
// are packed into the same turn, so a file is read about once per few
// topics instead of every turn re-reading the subject's first batch of
// files. Only a topic with no known source falls back to that first batch.

import { runCommand, backgroundTurnArgs, QUESTION_MODEL, QUESTION_EFFORT } from "./processUtil.js";
import { listContent } from "./content.js";
import { loadMaterial, excerptFor, materialBlock, MATERIAL_IS_DATA } from "./material.js";
import { batchFiles, MAX_FILES_PER_BATCH, MAX_BATCH_BYTES } from "./topicExtraction.js";
import { listTopics, listTopicsNeedingBank, markBankGenerated, getTopicById } from "./topics.js";
import { MAX_SESSION_TOPICS } from "./sessionBuilder.js";
import { addBankQuestions, QUESTION_TYPES, DIFFICULTIES } from "./questionBank.js";
import { listPreferences } from "./preferences.js";
import { formatPreferencesBlock } from "./preferencesPrompt.js";
import { getPersonaBlock } from "./persona/persona.js";

const DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "mcp__*"];

/** Topics asked about in a single turn. Keeps one turn's reply (several
 * questions per topic, each with a model answer/rubric) from growing
 * unbounded the way a huge multi-topic subject otherwise would. */
export const MAX_TOPICS_PER_BATCH = 4;

/** Questions are written a session's worth of topics at a time (issue
 * #10: writing them for every topic of a big upload at once could use up
 * a large share of a usage window in one go). After a Ready session,
 * `keepBankAhead` writes the next chunk in the background. */
export const BANK_CHUNK_TOPICS = MAX_SESSION_TOPICS;

/** Question-writing turns run at once. Doesn't change how much usage a
 * scan takes, only how long it takes (issue #10: 20 minutes for a big
 * upload); kept low so a scan doesn't hammer the account's rate limit. */
export const MAX_PARALLEL_TURNS = 3;

/** Questions requested per topic per generation pass — "several questions
 * of varied types and angles" (SPEC.md section 5), not meant to exhaust
 * every possible angle in one pass; `topUpTopicBank` (triggered by a Ready
 * session draining a topic) adds more using this same batch size. */
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
 *
 * A topic with `isNewTopic: true` (never reviewed via Live or Ready —
 * `fsrs.reps === 0`, the same check `liveSession.js`'s `isNewTopic` uses)
 * gets one of its questions flagged `isGenerationQuestion: true`: SPEC.md
 * section 6's Generation principle applied to Ready mode, the counterpart
 * to Live's "ask an attempt/prediction before any explanation" framing —
 * `readySession.js`'s `pickBankQuestion` serves that question first for
 * such a topic. A topic that's already been reviewed (via Live, or this
 * isn't its first bank) doesn't need one; generation only applies to a
 * topic's first-ever exposure, not every initial bank generation.
 */
export function buildBankPrompt({ subjectName, topics, files, questionsPerTopic = QUESTIONS_PER_TOPIC, preferences }) {
  const filesBlock = files.length
    ? `Ground your questions in the course material at the end of this message. ${MATERIAL_IS_DATA}`
    : `No uploaded material is available for these topics yet — use your own knowledge of each topic name/notes instead.`;

  const topicsBlock = topics
    .map((t, i) => `${i + 1}. "${t.name}"${t.notes ? ` — ${t.notes}` : ""}${t.isNewTopic ? " (the user has never been reviewed on this topic before)" : ""}`)
    .join("\n");

  const newTopicNames = topics.filter((t) => t.isNewTopic).map((t) => `"${t.name}"`);
  const generationBlock = newTopicNames.length
    ? `\nFor each topic marked "never been reviewed on this topic before" (${newTopicNames.join(", ")}): per this app's "generation" study principle, make exactly ONE of its questions an attempt-first question — do NOT explain the topic first; ask something that invites an attempt or a prediction (e.g. "what do you think X means", "how would you approach Y"), pitched at someone encountering it for the first time. Use one of these types for it: ${SELF_GRADED_TYPES.join(", ")} (not multiple_choice/cloze — those don't fit an open-ended first attempt). Set "isGenerationQuestion": true on that one question only; every other question (including the rest of that same topic's) should have "isGenerationQuestion": false.\n`
    : "";

  return `This is a one-shot background task, not a conversation. Don't ask questions back; just produce the question bank below and reply once.

${getPersonaBlock()}

Subject: ${subjectName}

${filesBlock}

Write a question bank for these topics:
${topicsBlock}

For EACH topic above, write exactly ${questionsPerTopic} questions, varied in type and angle (not ${questionsPerTopic} versions of the same question) — pick from: ${QUESTION_TYPES.join(", ")}. For every question, give:
- "prompt": the question text shown to the user (for "cloze", include a blank in the text, e.g. "_____").
- "difficulty": one of intro, medium, hard.
- "modelAnswer": a correct, complete answer, written in the voice above (specific, no padding, no inflation) — this is shown to the user verbatim later, as Ready mode's self-grading comparison.
- "rubric": the key points a correct answer should hit, as a short list — required for every type except multiple_choice/cloze (those are graded automatically from their own answer key below, not a rubric).
- "misconceptions": common wrong answers or mix-ups for this question, as a short list (can be empty if none are notable), also in the voice above.
- "isGenerationQuestion": true or false (see below; false unless told otherwise for a specific topic).
${generationBlock}
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
          "isGenerationQuestion": false,
          "choices": ["<option>"],
          "correctIndex": 0,
          "clozeAnswer": "<exact blank-filling text>"
        }
      ]
    }
  ],
  "summary": "<one sentence on what was generated>"
}
\`\`\`${formatPreferencesBlock(preferences)}${
    files.length
      ? `\n\nThe material:\n\n${materialBlock(files)}\n\n(End of material. Reply now, finishing with the athena-question-bank block described above.)`
      : ""
  }`;
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
    // Clamped to false for multiple_choice/cloze regardless of what the
    // reply says — the prompt already asks the model not to use those
    // types for a generation question, but a reply is untrusted input,
    // same posture as every other field here.
    isGenerationQuestion: raw.isGenerationQuestion === true && SELF_GRADED_TYPES.includes(raw.type),
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
  const result = await runCommand("claude", ["-p", ...backgroundTurnArgs([], { model: QUESTION_MODEL, effort: QUESTION_EFFORT }), "--disallowedTools", ...DENIED_TOOLS], {
    timeoutMs: TURN_TIMEOUT_MS,
    env,
    input: prompt,
  });
  if (result.code !== 0) {
    throw new Error(`claude exited with code ${result.code}: ${result.stderr.slice(0, 300)}`);
  }
  return result.stdout;
}

/**
 * The shared batch/prompt/parse/store pipeline behind both bank-generation
 * entry points below: given a subject (for grounding files) and an
 * explicit list of topics needing questions, runs one turn per bounded
 * batch and stores whatever valid questions come back. Doesn't touch
 * `bankGeneratedAt` — that's an "initial bank exists" marker the top-up
 * path must never set again; callers decide whether/when to mark it. A
 * topic the model skipped entirely, or returned with every question
 * rejected, is simply absent from `generatedTopicIds` so the caller can
 * leave it retryable, same "don't silently lose it" posture as
 * `scanSubjectForTopics`.
 */
/**
 * Groups topics into turns, each with the files to ground it in (issue
 * #10). A topic's files are its own sources (falling back to
 * `fallbackFiles` when none are known); topics sharing files go together,
 * and a turn takes another topic only while its combined files stay
 * within topicExtraction.js's per-turn file and size bounds (topics
 * adding no new files always fit). A topic whose own files are over the
 * bounds still gets a turn.
 * `filesById` maps content id -> {id, name, text, sizeBytes}, sized by
 * extracted text. Pure, exported for its own test.
 */
export function planBankTurns(topics, filesById, fallbackFiles, { maxTopics = MAX_TOPICS_PER_BATCH, maxFiles = MAX_FILES_PER_BATCH, maxBytes = MAX_BATCH_BYTES } = {}) {
  const withFiles = topics.map((topic) => {
    const own = (topic.sourceContentIds ?? []).map((id) => filesById.get(id)).filter(Boolean);
    const files = own.length ? own : fallbackFiles;
    return { topic, files, key: files.map((f) => f.id).sort().join(",") };
  });
  withFiles.sort((a, b) => a.key.localeCompare(b.key));

  const turns = [];
  let current = null;
  for (const { topic, files } of withFiles) {
    if (current) {
      const union = new Map(current.files.map((f) => [f.id, f]));
      for (const f of files) union.set(f.id, f);
      const bytes = [...union.values()].reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
      // Topics adding no new files always fit: an oversized file is
      // still read once for several of its topics, not once per topic.
      const addsFiles = union.size > current.files.length;
      if (current.topics.length < maxTopics && (!addsFiles || (union.size <= maxFiles && bytes <= maxBytes))) {
        current.topics.push(topic);
        current.files = [...union.values()];
        continue;
      }
      turns.push(current);
    }
    current = { topics: [topic], files: [...files] };
  }
  if (current) turns.push(current);
  return turns;
}

/** Runs `fn` over `items` with at most `limit` running at once. */
async function forEachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function generateAndStoreBank(appDataDir, subjectId, { subjectName, topics, runTurn = runBankGenerationTurn }) {
  const material = await loadMaterial(appDataDir, await listContent(appDataDir, subjectId));
  const filesById = new Map(material.map((f) => [f.id, f]));
  const fallbackFiles = batchFiles(material)[0] ?? [];
  const preferences = await listPreferences(appDataDir);

  // Same `fsrs.reps === 0` check liveSession.js's `isNewTopic` uses — a
  // topic can arrive here already reviewed via Live before ever getting a
  // Ready-mode bank, so this is independent of whether a bank already
  // exists (buildBankPrompt's header comment has the full reasoning).
  const annotatedTopics = topics.map((t) => ({ ...t, isNewTopic: (t.fsrs?.reps ?? 0) === 0 }));
  const turns = planBankTurns(annotatedTopics, filesById, fallbackFiles);

  const errors = [];
  const generatedTopicIds = [];
  let questionsAdded = 0;

  await forEachLimited(turns, MAX_PARALLEL_TURNS, async ({ topics: batch, files: turnFiles }) => {
    // A turn over the size bound (one long deck) carries only the slides
    // that mention its topics, shared out between its files.
    const total = turnFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
    const share = Math.floor(MAX_BATCH_BYTES / Math.max(1, turnFiles.length));
    const names = batch.map((t) => t.name);
    const files = total <= MAX_BATCH_BYTES ? turnFiles : turnFiles.map((f) => ({ ...f, text: excerptFor(f.text, names, share) }));
    const prompt = buildBankPrompt({ subjectName, topics: batch, files, preferences });

    let replyText;
    try {
      replyText = await runTurn(prompt);
    } catch (err) {
      errors.push(`${batch.length} topic(s) not processed: ${String(err.message ?? err).slice(0, 200)}`);
      return; // leave this batch's topics unmarked — retryable on the next scan
    }

    const parsed = parseBankReply(replyText);
    if (!parsed.ok) {
      errors.push(`${batch.length} topic(s) not processed: ${parsed.reason}`);
      return;
    }

    const byName = new Map(parsed.topics.map((t) => [t.topicName.trim().toLowerCase(), t]));
    for (const topic of batch) {
      const match = byName.get(topic.name.trim().toLowerCase());
      if (!match || !match.questions.length) {
        errors.push(`Topic "${topic.name}" not processed: the reply had no usable questions for it`);
        continue;
      }
      const added = await addBankQuestions(appDataDir, topic.id, topic.subjectId, match.questions);
      questionsAdded += added.length;
      generatedTopicIds.push(topic.id);
    }
  });

  return { generatedTopicIds, questionsAdded, errors };
}

// Same overlapping-trigger guard as topicExtraction.js's `inFlightSubjects`
// — a subject already being scanned simply skips a second concurrent
// call rather than racing it.
const inFlightSubjects = new Set();

/**
 * Writes the initial question bank for a subject's topics that don't have
 * one yet (`bankGeneratedAt` still null): at most `limit` of them, in the
 * order a session would study them (soonest due first), or only the given
 * `topicIds`. A topic is marked generated only once it has at least one
 * valid question saved for it; one the model skipped stays unmarked so a
 * later scan retries it, same "don't silently lose it" posture as
 * `scanSubjectForTopics`. `remaining` is how many topics still have no
 * questions afterwards.
 */
export async function scanSubjectForBankGeneration(
  appDataDir,
  subjectId,
  { subjectName, runTurn = runBankGenerationTurn, limit = Infinity, topicIds = null } = {},
) {
  if (inFlightSubjects.has(subjectId)) {
    return { ok: true, skipped: true, topicsProcessed: 0, questionsAdded: 0, remaining: 0, errors: [] };
  }
  inFlightSubjects.add(subjectId);
  try {
    let needingBank = await listTopicsNeedingBank(appDataDir, subjectId);
    if (topicIds) {
      const wanted = new Set(topicIds);
      needingBank = needingBank.filter((t) => wanted.has(t.id));
    }
    // Stable sort: same-due topics keep the order they were found in.
    const chunk = [...needingBank].sort((a, b) => (a.fsrs?.due ?? 0) - (b.fsrs?.due ?? 0)).slice(0, limit);
    if (!chunk.length) {
      const remaining = (await listTopicsNeedingBank(appDataDir, subjectId)).length;
      return { ok: true, skipped: false, topicsProcessed: 0, questionsAdded: 0, remaining, errors: [] };
    }

    const { generatedTopicIds, questionsAdded, errors } = await generateAndStoreBank(appDataDir, subjectId, {
      subjectName,
      topics: chunk,
      runTurn,
    });
    if (generatedTopicIds.length) {
      await markBankGenerated(appDataDir, generatedTopicIds);
    }
    const remaining = (await listTopicsNeedingBank(appDataDir, subjectId)).length;
    return { ok: errors.length === 0, skipped: false, topicsProcessed: generatedTopicIds.length, questionsAdded, remaining, errors };
  } finally {
    inFlightSubjects.delete(subjectId);
  }
}

/**
 * Keeps one chunk of never-studied topics with questions ready (issue
 * #10): if fewer than `BANK_CHUNK_TOPICS` are, writes questions for the
 * next ones in study order. Does nothing (no model call) when enough are
 * ready or every topic already has questions. Run after a Ready session.
 */
export async function keepBankAhead(appDataDir, subjectId, { subjectName, runTurn = runBankGenerationTurn } = {}) {
  const topics = await listTopics(appDataDir, subjectId);
  const ready = topics.filter((t) => t.bankGeneratedAt && (t.fsrs?.reps ?? 0) === 0).length;
  const want = BANK_CHUNK_TOPICS - ready;
  if (want <= 0 || !topics.some((t) => !t.bankGeneratedAt)) {
    return { ok: true, skipped: true, topicsProcessed: 0, questionsAdded: 0, remaining: 0, errors: [] };
  }
  return scanSubjectForBankGeneration(appDataDir, subjectId, { subjectName, runTurn, limit: want });
}

// A separate per-topic guard from `inFlightSubjects` above: a top-up
// targets one already-bank-having topic rather than a subject-wide sweep,
// so two Ready sessions ending around the same time can't double-fire a
// top-up for the same topic, but a subject-wide `/bank/scan` and a topic
// top-up are independent concerns and don't need to block each other.
const inFlightTopUpTopics = new Set();

/**
 * Tops up these topics' question banks (SPEC.md section 5: "topped up
 * after a Ready session that drained a topic's unused questions"), all
 * from one subject, in as few turns as the batching allows (issue #10:
 * one turn per topic before). Never touches `bankGeneratedAt`, since a
 * topic can only drain after its initial bank exists. Unknown ids are
 * skipped; a model-call failure or unparseable reply comes back as
 * `{ok: false, ...}`, same posture as the subject-wide scan.
 */
export async function topUpTopicBanks(appDataDir, topicIds, { subjectName, runTurn = runBankGenerationTurn } = {}) {
  const ids = topicIds.filter((id) => !inFlightTopUpTopics.has(id));
  if (!ids.length) return { ok: true, skipped: true, questionsAdded: 0, errors: [] };
  for (const id of ids) inFlightTopUpTopics.add(id);
  try {
    const topics = (await Promise.all(ids.map((id) => getTopicById(appDataDir, id)))).filter(Boolean);
    if (!topics.length) return { ok: true, skipped: true, questionsAdded: 0, errors: [] };
    const { questionsAdded, errors } = await generateAndStoreBank(appDataDir, topics[0].subjectId, {
      subjectName,
      topics,
      runTurn,
    });
    return { ok: errors.length === 0, skipped: false, questionsAdded, errors };
  } finally {
    for (const id of ids) inFlightTopUpTopics.delete(id);
  }
}

/** One topic's top-up. Throws on an unknown topic id (a caller mistake). */
export async function topUpTopicBank(appDataDir, topicId, options = {}) {
  if (!inFlightTopUpTopics.has(topicId) && !(await getTopicById(appDataDir, topicId))) {
    throw new Error(`Topic not found: ${topicId}`);
  }
  return topUpTopicBanks(appDataDir, [topicId], options);
}
