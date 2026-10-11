import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { extractPdfPages, pageLooksUnreliable, UNRELIABLE_EXTRACTION_MARKER } from "../pdfExtract.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-pdf-extract-"));
}

/** Generates a real multi-page PDF with pdfkit (never committed to the
 * repo — written fresh into a scratch tmpdir per test, same as other
 * tests' fixture files) so extractPdfPages() is exercised against an
 * actual PDF binary, not a stub. `pages` is an array of plain strings,
 * one per page. */
function writeSamplePdf(filePath, pages) {
  return new Promise((resolve, reject) => {
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
}

// --- pageLooksUnreliable: pure string function, no PDF needed (same
// design principle as extractors.py's _page_looks_unreliable — see
// pdfExtract.js's header comment). ---

test("pageLooksUnreliable: normal English prose is not flagged", () => {
  const text =
    "The quick brown fox jumps over the lazy dog. This is a normal " +
    "sentence with the word the several times. The study of algorithms " +
    "is central to the field and we rely on it at this point in the " +
    "course for the rest of the work.";
  assert.equal(pageLooksUnreliable(text), false);
});

test("pageLooksUnreliable: a short page with any (cid:N) marker is flagged", () => {
  // Mirrors the real-world "Lecture 1.pdf" case from extractors.py:
  // too short for the word-fraction check to have a meaningful sample,
  // so a single marker on a short page is sufficient.
  assert.equal(pageLooksUnreliable("Vg Ys Hr (cid:0) ?pshfibhYk"), true);
});

test("pageLooksUnreliable: a short page with no markers and no common words is not flagged", () => {
  // Below the word-count gate and no cid markers at all -- e.g. a title
  // slide reading just a course code, nothing to flag.
  assert.equal(pageLooksUnreliable("CSC4880"), false);
});

test("pageLooksUnreliable: a long page with one isolated cid marker in normal prose is not flagged", () => {
  const prose =
    "The utility function for this agent is defined over the state " +
    "space and the path cost is computed along the way. We discussed " +
    "the search strategy and the branching factor in the context of " +
    "the problem and the heuristic used by the algorithm for the task.";
  const text = `${prose} (cid:80) ${prose}`;
  assert.equal(pageLooksUnreliable(text), false);
});

test("pageLooksUnreliable: a long page whose font subset is broken (high cid density) is flagged", () => {
  const text = Array.from({ length: 60 }, (_, i) => `(cid:${i})`).join(" ");
  assert.equal(pageLooksUnreliable(text), true);
});

test("pageLooksUnreliable: long garbled-but-plausible-looking text with no cid markers and few common words is flagged", () => {
  // A Caesar-shift-style substitution: real letters, no (cid:N) markers,
  // but essentially none of the shifted "words" land on a common
  // English function word.
  const words = Array.from({ length: 50 }, (_, i) => `xqvbk${i}`);
  assert.equal(pageLooksUnreliable(words.join(" ")), true);
});

// --- extractPdfPages: real PDF binaries, generated fresh per test. ---

test("extractPdfPages returns one string per page with the expected text", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "sample.pdf");
  await writeSamplePdf(filePath, [
    "The quick brown fox jumps over the lazy dog and the cat too.",
    "Page two has different content about the history of the subject.",
  ]);

  const pages = await extractPdfPages(filePath);
  assert.equal(pages.length, 2);
  assert.match(pages[0], /quick brown fox/);
  assert.match(pages[1], /history of the subject/);
  // Normal prose shouldn't trip the unreliable-extraction marker.
  assert.doesNotMatch(pages[0], /EXTRACTION UNRELIABLE/);
  assert.doesNotMatch(pages[1], /EXTRACTION UNRELIABLE/);
});

test("extractPdfPages prepends the unreliable marker to a flagged page only", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "sample.pdf");
  // One normal page, one page whose only "content" is a run of cid-style
  // markers wrapped around digits -- pdfkit can't itself produce a
  // broken font subset, but pageLooksUnreliable only cares about the
  // extracted text shape, so literal "(cid:N)" text in the source
  // reproduces the same detection path extractPdfPages would hit on a
  // genuinely broken file.
  const brokenPage = Array.from({ length: 60 }, (_, i) => `(cid:${i})`).join(" ");
  await writeSamplePdf(filePath, [
    "This is a perfectly normal page with the usual common English words.",
    brokenPage,
  ]);

  const pages = await extractPdfPages(filePath);
  assert.equal(pages.length, 2);
  assert.doesNotMatch(pages[0], /EXTRACTION UNRELIABLE/);
  assert.ok(pages[1].startsWith(UNRELIABLE_EXTRACTION_MARKER));
});
