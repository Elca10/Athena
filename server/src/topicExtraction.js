// Topic extraction (SPEC.md section 7's third pipeline stage): the one
// background model turn in the content-ingestion pipeline. Detection
// ("which content items are new") and text extraction are both plain
// code (content.js); this is the single step that actually reads study
// material and proposes topic names, run as a one-shot, non-interactive
// `claude -p` call.
//
// Security/privacy shape, deliberately narrow — a comparable background
// turn elsewhere settled on exactly this shape after learning that a
// prompt-level instruction alone isn't a real boundary: the turn is
// pointed at specific absolute file paths and told to Read only those,
// backed by a hard `--disallowedTools` deny list so that's enforced
// rather than merely requested. Nobody reviews this turn's transcript —
// its only consumed output is the one fenced JSON block this module
// parses itself — and the material it reads is the user's own course
// content, not something to let it act on any further than "describe
// what's in it".

import { promises as fs } from "node:fs";
import { runCommand } from "./processUtil.js";
import { listContent, markTopicsExtracted, parsedFilePath } from "./content.js";
import { addPlannedTopics, listTopics } from "./topics.js";

/** Tools this turn can never use. Read is deliberately not on this list —
 * it's the only tool the turn needs, pointed at the exact paths named in
 * the prompt. */
const DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "mcp__*"];

/** Most files one extraction turn is pointed at. */
export const MAX_FILES_PER_BATCH = 6;

/** Most bytes of source material one extraction turn is pointed at — the
 * turn reads the files itself, so this bounds its *context*. A single
 * file bigger than this still gets a batch of its own rather than being
 * skipped outright. */
export const MAX_BATCH_BYTES = 150_000;

/** Most topics accepted from a single turn's reply. */
export const MAX_TOPICS_PER_RUN = 12;

const MAX_NOTE_CHARS = 200;
const MAX_REPLY_CHARS = 400_000;

// Long enough for a turn that reads several files and thinks about them;
// short enough that a hung CLI doesn't block a scan forever.
const TURN_TIMEOUT_MS = 180_000;

const TAGGED_FENCE_RE = /```json\s+athena-topics\s*\n([\s\S]*?)```/g;
const PLAIN_FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;

function isPlausibleTopicName(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (/[\r\n]/.test(trimmed)) return false;
  return true;
}

/**
 * Splits files into batches bounded by count and total bytes, so a large
 * upload can't become one unbounded prompt. Pure, exported for its own
 * test.
 */
export function batchFiles(files, { maxFiles = MAX_FILES_PER_BATCH, maxBytes = MAX_BATCH_BYTES } = {}) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const file of files) {
    const size = file.sizeBytes ?? 0;
    if (current.length && (current.length >= maxFiles || currentBytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * The prompt for one batch. Pure, exported for its own test. `files` are
 * `{absolutePath}`.
 */
export function buildExtractionPrompt({ subjectName, files, existingTopics = [], batchIndex, batchCount }) {
  const existingBlock = existingTopics.length
    ? `These topics are already tracked for this subject — do not repeat any of them, only propose what's missing:\n${existingTopics
        .map((t) => `- ${t}`)
        .join("\n")}`
    : `Nothing is tracked for this subject yet, so everything you propose will be new.`;

  const batchLine =
    batchCount > 1
      ? `\n\nThis is batch ${batchIndex + 1} of ${batchCount} of this subject's new material — just cover these files, the rest are handled separately.`
      : "";

  return `This is a one-shot background task, not a conversation. Don't ask questions; just do the task below and reply once.

New study material was added for the subject "${subjectName}". Read these files — these exact paths, and nothing else, using the Read tool — and tell me what topics they cover:
${files.map((f) => `- ${f.absolutePath}`).join("\n")}${batchLine}

${existingBlock}

Reply with up to ${MAX_TOPICS_PER_RUN} topics actually covered by this material. Each topic must be a short, specific, quizzable label of a few words ("Binary search trees", "Krebs cycle", "Supply and demand shifts") — not a sentence, not a whole lecture, no newlines inside a name. Broad coverage matters more than depth on any one item. If a file is unreadable or empty, say so in "summary" and cover the rest.

Finish your reply with exactly one fenced block in this exact form, and nothing after it:

\`\`\`json athena-topics
{
  "topics": [
    {"name": "<short topic name>", "notes": "<optional one-line note on what it covers>"}
  ],
  "summary": "<one sentence on what the material covered>"
}
\`\`\``;
}

/**
 * Extracts the topic list from a turn's raw reply text. Never throws — the
 * reply is untrusted input (it can be truncated, fenced wrong, not fenced
 * at all, or the right shape with garbage inside it).
 *
 * Preference order, most-specific first: the LAST correctly-tagged fence,
 * then the last plain fence, then the bare reply text — last rather than
 * first so a reply that restates the format before filling it in isn't
 * parsed from its own example.
 */
export function parseExtractionReply(resultText) {
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
  if (!data) return { ok: false, reason: "no readable topic list in the reply" };

  const topics = [];
  const seen = new Set();
  let rejected = 0;
  for (const raw of data.topics) {
    const name = (typeof raw === "string" ? raw : raw?.name) ?? "";
    const trimmed = String(name).trim();
    if (!isPlausibleTopicName(trimmed)) {
      rejected += 1;
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    if (topics.length >= MAX_TOPICS_PER_RUN) break;
    seen.add(key);
    topics.push({
      name: trimmed,
      notes: typeof raw === "object" && raw ? String(raw.notes ?? "").slice(0, MAX_NOTE_CHARS) : "",
    });
  }

  // Every entry rejected is a malformed reply, not "nothing to add" — a
  // genuine "nothing new here" answer is `"topics": []` with nothing to
  // reject, which is handled below via `empty`.
  if (!topics.length && rejected) {
    return { ok: false, reason: `the reply's topic list had nothing usable in it (${rejected} entries rejected as not topic names)` };
  }

  return {
    ok: true,
    topics,
    empty: topics.length === 0,
    summary: typeof data.summary === "string" ? data.summary.slice(0, MAX_NOTE_CHARS) : "",
  };
}

/**
 * Test seam for the model call — route/pipeline tests inject their own
 * `runTurn` so no test ever shells out to the real `claude` CLI or spends
 * a real turn. `env` is a narrower seam for this function's own test,
 * matching setupChecks.js's `checkClaudeCode({env})` convention: passed
 * straight to `runCommand`, defaulting to the full inherited environment
 * (so a real call finds the real `claude` on PATH) but overridable to a
 * scratch PATH pointing at a fake script, so this module's own test can
 * verify the exact argv without ever finding the real CLI.
 */
export async function runExtractionTurn(prompt, { env } = {}) {
  const result = await runCommand("claude", ["-p", "--disallowedTools", ...DENIED_TOOLS, "--", prompt], {
    timeoutMs: TURN_TIMEOUT_MS,
    env,
  });
  if (result.code !== 0) {
    throw new Error(`claude exited with code ${result.code}: ${result.stderr.slice(0, 300)}`);
  }
  return result.stdout;
}

// Guards against two overlapping triggers for the SAME subject (e.g. two
// uploads landing within the same second) sending the same unprocessed
// files to two separate turns at once. That would be wasted cost and
// duplicate work, not a data-safety problem either way: topics.js dedupes
// by name regardless, and content.js's own store lock keeps the
// processed-flag write safe. A scan already in flight for a subject is
// simply skipped — whichever one is running will still see those files.
const inFlightSubjects = new Set();

/**
 * Scans a subject's content items that haven't had topics extracted yet,
 * runs one background turn per bounded batch, and seeds whatever topics
 * come back as planned topics. A file is marked processed only once its
 * batch's topics are saved, in the same store update — so a crash, a
 * failed turn, or an unparseable reply leaves it unprocessed and the next
 * scan retries it rather than silently losing it.
 */
export async function scanSubjectForTopics(appDataDir, subjectId, { subjectName, runTurn = runExtractionTurn } = {}) {
  if (inFlightSubjects.has(subjectId)) {
    return { ok: true, skipped: true, topicsAdded: 0, filesProcessed: 0, errors: [] };
  }
  inFlightSubjects.add(subjectId);
  try {
    const content = await listContent(appDataDir, subjectId);
    const unprocessed = content.filter((c) => !c.topicsExtractedAt);
    if (!unprocessed.length) return { ok: true, skipped: false, topicsAdded: 0, filesProcessed: 0, errors: [] };

    const errors = [];
    const files = [];
    for (const item of unprocessed) {
      const absolutePath = parsedFilePath(appDataDir, item);
      try {
        await fs.access(absolutePath);
      } catch {
        // No parsed text on disk yet for this item — leave it unprocessed
        // rather than erroring; a future scan with the file present (or a
        // user re-upload) will pick it up.
        continue;
      }
      files.push({ ...item, absolutePath });
    }
    if (!files.length) return { ok: true, skipped: false, topicsAdded: 0, filesProcessed: 0, errors };

    const batches = batchFiles(files);
    let topicsAdded = 0;
    let filesProcessed = 0;

    for (const [index, batch] of batches.entries()) {
      const existingTopics = (await listTopics(appDataDir, subjectId)).map((t) => t.name);
      const prompt = buildExtractionPrompt({
        subjectName,
        files: batch,
        existingTopics,
        batchIndex: index,
        batchCount: batches.length,
      });

      let replyText;
      try {
        replyText = await runTurn(prompt);
      } catch (err) {
        errors.push(`${batch.length} file(s) not processed: ${String(err.message ?? err).slice(0, 200)}`);
        continue; // leave this batch's files unprocessed — retryable on the next scan
      }

      const parsed = parseExtractionReply(replyText);
      if (!parsed.ok) {
        errors.push(`${batch.length} file(s) not processed: ${parsed.reason}`);
        continue;
      }

      // A well-formed reply with zero topics ("nothing new in this
      // material") is a real answer, not a failure — its files are still
      // marked processed below so the next scan doesn't re-read and
      // re-send them forever.
      if (parsed.topics.length) {
        const added = await addPlannedTopics(appDataDir, subjectId, parsed.topics);
        topicsAdded += added.length;
      }
      filesProcessed += batch.length;
      await markTopicsExtracted(appDataDir, batch.map((f) => f.id));
    }

    return { ok: errors.length === 0, skipped: false, topicsAdded, filesProcessed, errors };
  } finally {
    inFlightSubjects.delete(subjectId);
  }
}
