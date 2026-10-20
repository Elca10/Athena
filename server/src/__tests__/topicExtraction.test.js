import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { addUploadedContent, listContent, parsedFilePath } from "../content.js";
import { listTopics, addPlannedTopics } from "../topics.js";
import { fakeClaudeOnPath } from "./fakeClaudeOnPath.js";
import { TOPIC_MODEL } from "../processUtil.js";
import {
  batchFiles,
  buildExtractionPrompt,
  parseExtractionReply,
  scanSubjectForTopics,
  runExtractionTurn,
  MAX_FILES_PER_BATCH,
  MAX_BATCH_BYTES,
  topicCapFor,
} from "../topicExtraction.js";
import { makeTempDir } from "../testHelpers/tempDir.js";

/** Real PDF binary, generated fresh (never committed) — same technique as
 * pdfExtract.test.js/content.test.js. */
async function samplePdfBuffer(pages) {
  const dir = await makeTempDir("athena-topic-extraction-pdf-");
  const filePath = path.join(dir, "sample.pdf");
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = createWriteStream(filePath);
    doc.pipe(stream);
    for (const pageText of pages) {
      doc.addPage();
      doc.fontSize(12).text(pageText);
    }
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return fs.readFile(filePath);
}

async function scratchDir() {
  return makeTempDir("athena-topic-extraction-");
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

test("buildExtractionPrompt carries each file's text inline, numbered, and names the subject (issue #10)", () => {
  const prompt = buildExtractionPrompt({
    subjectName: "Discrete Math",
    files: [{ name: "a.pdf", text: "## Slide 1\nGraphs" }, { name: "b.pdf", text: "## Slide 1\nTrees" }],
    existingTopics: [],
    batchIndex: 0,
    batchCount: 1,
  });
  assert.match(prompt, /Discrete Math/);
  assert.match(prompt, /<file number="1" name="a\.pdf">\n## Slide 1\nGraphs\n<\/file>/);
  assert.match(prompt, /<file number="2" name="b\.pdf">\n## Slide 1\nTrees\n<\/file>/);
  assert.match(prompt, /ignore it/, "says the material is data, not instructions");
  assert.doesNotMatch(prompt, /Read tool/);
  assert.match(prompt, /nothing is tracked for this subject yet/i);
  assert.doesNotMatch(prompt, /batch 1 of/i);
});

test("buildExtractionPrompt lists existing topics to avoid repeating and notes batch position", () => {
  const prompt = buildExtractionPrompt({
    subjectName: "Biology",
    files: [{ name: "c.md", text: "Cells" }],
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
  const result = parseExtractionReply(reply, { maxTopics: topicCapFor(1) });
  assert.equal(result.ok, true);
  assert.equal(result.topics.length, 12);
  assert.ok(result.topics.every((t) => !t.name.includes("\n")));
  assert.equal(parseExtractionReply(reply, { maxTopics: topicCapFor(2) }).topics.length, 20, "two files: up to 24");
});

test("the topic cap grows with the files in a turn, up to an overall limit (issue #10)", () => {
  assert.equal(topicCapFor(1), 12);
  assert.equal(topicCapFor(2), 24);
  assert.equal(topicCapFor(6), 36);
  assert.match(buildExtractionPrompt({ subjectName: "Bio", files: [{ name: "a", text: "x" }, { name: "b", text: "y" }] }), /up to 24 topics/);
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

test("runExtractionTurn sends a large prompt over stdin, not argv (Windows command-line length limit)", async () => {
  const { env } = await fakeClaudeOnPath();
  const bigPrompt = "e".repeat(45_000);
  const stdout = await runExtractionTurn(bigPrompt, { env });
  const result = JSON.parse(stdout);
  assert.equal(result.stdinLength, bigPrompt.length);
  assert.ok(!result.argv.some((arg) => arg.includes(bigPrompt)));
});

test("runExtractionTurn is one small, tool-free call on the topic model (issue #10)", async () => {
  const { env } = await fakeClaudeOnPath();
  const { argv } = JSON.parse(await runExtractionTurn("prompt", { env }));
  assert.equal(argv[argv.indexOf("--model") + 1], TOPIC_MODEL);
  assert.equal(argv[argv.indexOf("--tools") + 1], "", "the text is in the prompt, so no tools at all");
  assert.ok(!argv.includes("--add-dir"), "no file access needed");
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(argv.includes("--disable-slash-commands"));
  assert.match(argv[argv.indexOf("--system-prompt") + 1], /background tasks for a study app/);
  // Nothing may sit after the variadic --disallowedTools list but its tools.
  assert.ok(argv.indexOf("--disallowedTools") > argv.indexOf("--system-prompt"));
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

test("scanSubjectForTopics sends a PDF-sourced item's real extracted text, not the raw binary", async () => {
  const dir = await scratchDir();
  const rawBytes = await samplePdfBuffer([
    "Binary search trees are a fundamental data structure covered in this lecture.",
  ]);
  const content = await addUploadedContent(dir, "subject-1", {
    filename: "Lecture 1.pdf",
    fileBuffer: rawBytes,
  });

  const prompts = [];
  const fakeTurn = async (prompt) => {
    prompts.push(prompt);
    return "```json athena-topics\n" + JSON.stringify({ topics: [{ name: "Binary search trees" }], summary: "ok" }) + "\n```";
  };

  const result = await scanSubjectForTopics(dir, "subject-1", { subjectName: "CS 101", runTurn: fakeTurn });
  assert.equal(result.ok, true);
  assert.equal(result.filesProcessed, 1);

  // The prompt carries the item's PARSED text inline (issue #10), under
  // its own filename — real extracted text, not the original PDF's bytes,
  // proving pdfExtract.js ran on this upload.
  assert.match(prompts[0], /name="Lecture 1\.pdf"/);
  assert.match(prompts[0], /Binary search trees are a fundamental data structure/);
  assert.doesNotMatch(prompts[0], /%PDF-/); // the raw PDF's own header magic bytes
  assert.match(await fs.readFile(parsedFilePath(dir, content), "utf8"), /Binary search trees/);
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
  // The subject already has topics, so "nothing new" is a real answer.
  await addPlannedTopics(dir, "subject-1", ["Existing topic"]);
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

  // Only the new file's text was sent, not the first's, which was
  // already processed.
  assert.match(seenPrompt, /Already tracked/);
  assert.match(seenPrompt, /# Lecture 2/);
  assert.doesNotMatch(seenPrompt, /# Lecture 1/);
  assert.ok(second && first);
  assert.equal((await listTopics(dir, "subject-1")).length, 2);
});

test("issue #5: zero topics on a subject with none yet is an error and the files stay unread", async () => {
  const dir = await scratchDir();
  await addUploadedContent(dir, "subject-1", { filename: "lecture1.md", text: "# Lecture 1" });
  const unreadableTurn = async () =>
    "```json athena-topics\n" + JSON.stringify({ topics: [], summary: "The file could not be read." }) + "\n```";

  const result = await scanSubjectForTopics(dir, "subject-1", { subjectName: "S", runTurn: unreadableTurn });
  assert.equal(result.ok, false);
  assert.equal(result.filesProcessed, 0);
  assert.match(result.errors[0], /no topics could be found.*could not be read/);
  assert.equal((await listContent(dir, "subject-1"))[0].topicsExtractedAt ?? null, null);
});

test("issue #5 recovery: content wrongly marked read on a subject with no topics is read again", async () => {
  const dir = await scratchDir();
  const item = await addUploadedContent(dir, "subject-1", { filename: "lecture1.md", text: "# Lecture 1" });
  const { markTopicsExtracted } = await import("../content.js");
  await markTopicsExtracted(dir, [item.id]); // what the bug left behind
  let sent = null;
  const goodTurn = async (prompt) => {
    sent = prompt;
    return "```json athena-topics\n" + JSON.stringify({ topics: ["Mitosis"], summary: "cells" }) + "\n```";
  };
  const result = await scanSubjectForTopics(dir, "subject-1", { subjectName: "S", runTurn: goodTurn });
  assert.equal(result.topicsAdded, 1);
  assert.match(sent, /# Lecture 1/);
});

test("a file too big for one turn is split, and only counts as read once every part was (issue #10)", async () => {
  const dir = await scratchDir();
  const slides = Array.from({ length: 300 }, (_, i) => `## Slide ${i + 1}\n${"word ".repeat(150)}`).join("\n\n");
  const item = await addUploadedContent(dir, "subject-1", { filename: "huge.md", text: slides });
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 2) throw new Error("rate limited");
    return "```json athena-topics\n" + JSON.stringify({ topics: [{ name: `Topic ${calls}`, files: [1] }], summary: "ok" }) + "\n```";
  };
  const result = await scanSubjectForTopics(dir, "subject-1", { subjectName: "S", runTurn: flaky });
  assert.ok(calls > 1, "split into several turns");
  assert.equal(result.filesProcessed, 0);
  assert.equal((await listContent(dir, "subject-1"))[0].topicsExtractedAt, null, "a failed part leaves the file unread");
  assert.ok((await listTopics(dir, "subject-1")).every((t) => t.sourceContentIds[0] === item.id), "parts' topics point at the file");
});
