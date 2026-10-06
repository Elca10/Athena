import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addUploadedContent, listContent } from "../content.js";
import { listTopics } from "../topics.js";
import {
  batchFiles,
  buildExtractionPrompt,
  parseExtractionReply,
  scanSubjectForTopics,
  runExtractionTurn,
  MAX_FILES_PER_BATCH,
  MAX_BATCH_BYTES,
} from "../topicExtraction.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-topic-extraction-"));
}

// An env whose PATH points nowhere real — same technique
// setupChecks.test.js already uses to make "claude not found" deterministic
// on any machine, regardless of whether the real CLI happens to be
// installed (this dev machine genuinely has it; a CI runner genuinely
// doesn't). Faking a *successful* CLI response would mean writing a fake
// executable script, which setupChecks.test.js deliberately doesn't do
// either, since a POSIX shell script isn't something the windows-latest CI
// leg could run — the orchestration layer's own tests (above) already
// cover the "turn ran and returned text" path via dependency injection, so
// this function only needs its error path (and its argv shape) proven.
function emptyPathEnv() {
  return { PATH: os.tmpdir() };
}

// --- batchFiles ------------------------------------------------------------

test("batchFiles puts everything in one batch when under both caps", () => {
  const files = [{ sizeBytes: 10 }, { sizeBytes: 20 }];
  assert.deepEqual(batchFiles(files), [files]);
});

test("batchFiles splits once the file-count cap is hit", () => {
  const files = Array.from({ length: MAX_FILES_PER_BATCH + 2 }, (_, i) => ({ sizeBytes: 1, i }));
  const batches = batchFiles(files);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, MAX_FILES_PER_BATCH);
  assert.equal(batches[1].length, 2);
});

test("batchFiles splits once the byte cap is hit", () => {
  const files = [{ sizeBytes: MAX_BATCH_BYTES - 10 }, { sizeBytes: 20 }, { sizeBytes: 5 }];
  const batches = batchFiles(files);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0], [files[0]]);
  assert.deepEqual(batches[1], [files[1], files[2]]);
});

test("batchFiles gives an oversized single file a batch of its own rather than dropping it", () => {
  const huge = { sizeBytes: MAX_BATCH_BYTES * 2 };
  const small = { sizeBytes: 5 };
  const batches = batchFiles([huge, small]);
  assert.deepEqual(batches, [[huge], [small]]);
});

// --- buildExtractionPrompt --------------------------------------------------

test("buildExtractionPrompt lists file paths and names the subject", () => {
  const prompt = buildExtractionPrompt({
    subjectName: "Discrete Math",
    files: [{ absolutePath: "/tmp/a.md" }, { absolutePath: "/tmp/b.md" }],
    existingTopics: [],
    batchIndex: 0,
    batchCount: 1,
  });
  assert.match(prompt, /Discrete Math/);
  assert.match(prompt, /\/tmp\/a\.md/);
  assert.match(prompt, /\/tmp\/b\.md/);
  assert.match(prompt, /nothing is tracked for this subject yet/i);
  assert.doesNotMatch(prompt, /batch 1 of/i);
});

test("buildExtractionPrompt lists existing topics to avoid repeating and notes batch position", () => {
  const prompt = buildExtractionPrompt({
    subjectName: "Biology",
    files: [{ absolutePath: "/tmp/c.md" }],
    existingTopics: ["Osmosis", "Mitosis"],
    batchIndex: 1,
    batchCount: 3,
  });
  assert.match(prompt, /- Osmosis/);
  assert.match(prompt, /- Mitosis/);
  assert.match(prompt, /batch 2 of 3/i);
});

// --- parseExtractionReply ----------------------------------------------------

test("parseExtractionReply reads the tagged fence", () => {
  const reply = [
    "Here you go.",
    "```json athena-topics",
    JSON.stringify({ topics: [{ name: "Linked lists", notes: "singly/doubly" }], summary: "intro data structures" }),
    "```",
  ].join("\n");
  const result = parseExtractionReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.topics.length, 1);
  assert.equal(result.topics[0].name, "Linked lists");
  assert.equal(result.summary, "intro data structures");
  assert.equal(result.empty, false);
});

test("parseExtractionReply falls back to a plain fence when the tag is missing", () => {
  const reply = ["```", JSON.stringify({ topics: ["Stacks"] }), "```"].join("\n");
  const result = parseExtractionReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.topics[0].name, "Stacks");
});

test("parseExtractionReply prefers the LAST fence, so a restated example isn't parsed", () => {
  const example = "```json athena-topics\n" + JSON.stringify({ topics: [{ name: "EXAMPLE TOPIC" }] }) + "\n```";
  const real = "```json athena-topics\n" + JSON.stringify({ topics: [{ name: "Queues" }] }) + "\n```";
  const result = parseExtractionReply(`Here's the format:\n${example}\n\nMy actual answer:\n${real}`);
  assert.equal(result.ok, true);
  assert.equal(result.topics.length, 1);
  assert.equal(result.topics[0].name, "Queues");
});

test("parseExtractionReply treats a deliberate empty topic list as a real, non-failure answer", () => {
  const reply = "```json athena-topics\n" + JSON.stringify({ topics: [], summary: "nothing new here" }) + "\n```";
  const result = parseExtractionReply(reply);
  assert.equal(result.ok, true);
  assert.equal(result.empty, true);
  assert.equal(result.topics.length, 0);
});

test("parseExtractionReply rejects an empty reply", () => {
  assert.equal(parseExtractionReply("").ok, false);
  assert.equal(parseExtractionReply("   ").ok, false);
});

test("parseExtractionReply rejects a reply with no fenced JSON at all", () => {
  const result = parseExtractionReply("I read the files but didn't format anything.");
  assert.equal(result.ok, false);
  assert.match(result.reason, /no readable topic list/i);
});

test("parseExtractionReply rejects malformed JSON in the fence", () => {
  const result = parseExtractionReply("```json athena-topics\n{not valid json\n```");
  assert.equal(result.ok, false);
});

test("parseExtractionReply caps topic count, dedupes, and rejects implausible names", () => {
  const topics = Array.from({ length: 20 }, (_, i) => ({ name: `Topic ${i}` }));
  topics.push({ name: "Topic 0" }); // duplicate
  topics.push({ name: "a".repeat(200) }); // too long
  topics.push({ name: "line one\nline two" }); // newline
  const reply = "```json athena-topics\n" + JSON.stringify({ topics }) + "\n```";
  const result = parseExtractionReply(reply);
  assert.equal(result.ok, true);
  assert.ok(result.topics.length <= 12);
  assert.ok(result.topics.every((t) => !t.name.includes("\n")));
});

test("parseExtractionReply reports failure when every proposed entry is rejected", () => {
  const reply = "```json athena-topics\n" + JSON.stringify({ topics: [{ name: "" }, { name: "x".repeat(200) }] }) + "\n```";
  const result = parseExtractionReply(reply);
  assert.equal(result.ok, false);
  assert.match(result.reason, /rejected/i);
});

// --- runExtractionTurn -------------------------------------------------------

test("runExtractionTurn rejects with a clear error when the claude CLI can't be found", async () => {
  await assert.rejects(() => runExtractionTurn("irrelevant prompt", { env: emptyPathEnv() }), (err) => {
    assert.ok(err.notFound || /ENOENT/.test(err.message));
    return true;
  });
});

// --- scanSubjectForTopics (the orchestration) -------------------------------

test("scanSubjectForTopics does nothing when there is no unprocessed content", async () => {
  const dir = await scratchDir();
  const result = await scanSubjectForTopics(dir, "subject-1", { subjectName: "Empty Subject" });
  assert.deepEqual(result, { ok: true, skipped: false, topicsAdded: 0, filesProcessed: 0, errors: [] });
});

test("scanSubjectForTopics runs a turn per batch, saves topics, and marks files processed", async () => {
  const dir = await scratchDir();
  await addUploadedContent(dir, "subject-1", { filename: "lecture1.md", text: "# Lecture 1" });
  await addUploadedContent(dir, "subject-1", { filename: "lecture2.md", text: "# Lecture 2" });

  const prompts = [];
  const fakeTurn = async (prompt) => {
    prompts.push(prompt);
    return "```json athena-topics\n" + JSON.stringify({ topics: [{ name: "Topic from fake turn" }], summary: "ok" }) + "\n```";
  };

  const result = await scanSubjectForTopics(dir, "subject-1", { subjectName: "Test Subject", runTurn: fakeTurn });
  assert.equal(result.ok, true);
  assert.equal(result.topicsAdded, 1);
  assert.equal(result.filesProcessed, 2);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Test Subject/);

  const topics = await listTopics(dir, "subject-1");
  assert.equal(topics.length, 1);
  assert.equal(topics[0].name, "Topic from fake turn");

  const content = await listContent(dir, "subject-1");
  assert.ok(content.every((c) => typeof c.topicsExtractedAt === "string"));
});

test("scanSubjectForTopics never re-sends content whose topics were already extracted", async () => {
  const dir = await scratchDir();
  await addUploadedContent(dir, "subject-1", { filename: "lecture1.md", text: "# Lecture 1" });

  let calls = 0;
  const fakeTurn = async () => {
    calls += 1;
    return "```json athena-topics\n" + JSON.stringify({ topics: [{ name: "First pass topic" }] }) + "\n```";
  };

  await scanSubjectForTopics(dir, "subject-1", { subjectName: "S", runTurn: fakeTurn });
  const second = await scanSubjectForTopics(dir, "subject-1", { subjectName: "S", runTurn: fakeTurn });
  assert.equal(calls, 1);
  assert.equal(second.filesProcessed, 0);
});

test("scanSubjectForTopics leaves a batch's files unprocessed when the turn throws", async () => {
  const dir = await scratchDir();
  const record = await addUploadedContent(dir, "subject-1", { filename: "lecture1.md", text: "# Lecture 1" });

  const failingTurn = async () => {
    throw new Error("claude CLI not found");
  };
  const result = await scanSubjectForTopics(dir, "subject-1", { subjectName: "S", runTurn: failingTurn });
  assert.equal(result.ok, false);
  assert.equal(result.filesProcessed, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /claude CLI not found/);

  const content = await listContent(dir, "subject-1");
  assert.equal(content.find((c) => c.id === record.id).topicsExtractedAt, null);
});

test("scanSubjectForTopics leaves a batch's files unprocessed when the reply can't be parsed", async () => {
  const dir = await scratchDir();
  await addUploadedContent(dir, "subject-1", { filename: "lecture1.md", text: "# Lecture 1" });

  const garbledTurn = async () => "no fenced block here at all";
  const result = await scanSubjectForTopics(dir, "subject-1", { subjectName: "S", runTurn: garbledTurn });
  assert.equal(result.ok, false);
  assert.equal(result.filesProcessed, 0);
  assert.equal(result.topicsAdded, 0);
});

test("scanSubjectForTopics marks files processed on a well-formed empty-topics reply, so they aren't re-sent", async () => {
  const dir = await scratchDir();
  await addUploadedContent(dir, "subject-1", { filename: "lecture1.md", text: "# Lecture 1" });

  let calls = 0;
  const nothingNewTurn = async () => {
    calls += 1;
    return "```json athena-topics\n" + JSON.stringify({ topics: [], summary: "nothing new" }) + "\n```";
  };

  const first = await scanSubjectForTopics(dir, "subject-1", { subjectName: "S", runTurn: nothingNewTurn });
  assert.equal(first.ok, true);
  assert.equal(first.topicsAdded, 0);
  assert.equal(first.filesProcessed, 1);

  const second = await scanSubjectForTopics(dir, "subject-1", { subjectName: "S", runTurn: nothingNewTurn });
  assert.equal(second.filesProcessed, 0);
  assert.equal(calls, 1);
});

test("scanSubjectForTopics only sends newly-added files, with already-tracked topics passed as existingTopics", async () => {
  const dir = await scratchDir();
  const first = await addUploadedContent(dir, "subject-1", { filename: "lecture1.md", text: "# Lecture 1" });

  await scanSubjectForTopics(dir, "subject-1", {
    subjectName: "S",
    runTurn: async () => "```json athena-topics\n" + JSON.stringify({ topics: [{ name: "Already tracked" }] }) + "\n```",
  });

  const second = await addUploadedContent(dir, "subject-1", { filename: "lecture2.md", text: "# Lecture 2" });

  let seenPrompt = null;
  await scanSubjectForTopics(dir, "subject-1", {
    subjectName: "S",
    runTurn: async (prompt) => {
      seenPrompt = prompt;
      return "```json athena-topics\n" + JSON.stringify({ topics: [{ name: "New topic" }] }) + "\n```";
    },
  });

  // The prompt is keyed on each content item's id-based parsed-file path
  // (content.js never files anything under the user's own filename), so
  // the second item's file path is what proves only the new file was
  // sent — not the first's, which was already processed.
  assert.match(seenPrompt, /Already tracked/);
  assert.match(seenPrompt, new RegExp(second.id));
  assert.doesNotMatch(seenPrompt, new RegExp(first.id));
  assert.equal((await listTopics(dir, "subject-1")).length, 2);
});
