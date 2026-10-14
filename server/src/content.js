// Content ingestion (SPEC.md section 7): the "Add content" flow for a
// subject, plus the "paste class notes" text box. Plain text/markdown's
// local, no-network, no-model extraction step is the identity transform
// (there's nothing to decode), so raw and parsed end up as the same text,
// just filed under a deterministic id-based name. PDF and PPTX support
// (real extraction via pdfExtract.js / pptxExtract.js, including their
// shared garbled-text detection) is wired in below via
// `BINARY_EXTRACTORS`; DOCX is still rejected as "not yet supported" —
// its own extractor is a later build-13-step-2 sub-step. Topic extraction
// (the one background model turn that reads newly parsed files) is
// topicExtraction.js, which reads a content item's `topicsExtractedAt`
// field and `parsedFilePath` below; it reads whatever text ended up in
// the parsed file regardless of the original format, so nothing there
// needed to change for either binary format.
//
// Raw/parsed files are named `<id><ext>`, never the user's own filename —
// sidesteps path-traversal and odd-character handling by construction.
// The original name is kept in the metadata record for display.
//
// Doesn't verify `subjectId` refers to a real subject — same decoupling
// `subjects.js` itself has from everything above it; callers (the route)
// check that first so a bad id 404s instead of silently filing content
// under a subject that doesn't exist.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { appDataSubdirs } from "./dataDir.js";
import { makeJsonFileStore } from "./store/jsonFileStore.js";
import { extractPdfPages } from "./pdfExtract.js";
import { extractPptxSlides } from "./pptxExtract.js";

const FILE_NAME = "content.json";

// Plain-text formats, ingested as-is (identity extraction).
const TEXT_EXTENSIONS = [".txt", ".md", ".markdown"];

// Binary formats with a real extraction step, keyed by extension. Each
// extractor returns `{ [unitsKey]: string[], [unreliableKey]: number[] }`
// (pdfExtract.js's `pages`/`unreliablePageNumbers`, pptxExtract.js's
// `slides`/`unreliableSlideNumbers`) — `ingestBinary` below reads through
// this table rather than hard-coding either shape, so adding a format
// (e.g. DOCX) only means adding an entry here. DOCX isn't here yet —
// it's rejected by the "unsupported file type" check below until its own
// extractor lands.
const BINARY_EXTRACTORS = {
  ".pdf": {
    extract: extractPdfPages,
    unitsKey: "pages",
    unreliableKey: "unreliablePageNumbers",
    unitLabel: "Page",
    formatName: "PDF",
    // A scanned, image-only PDF has no text layer at all — called out
    // specifically since it's the common real-world cause.
    emptyHint: " (it may be a scanned, image-only document)",
  },
  ".pptx": {
    extract: extractPptxSlides,
    unitsKey: "slides",
    unreliableKey: "unreliableSlideNumbers",
    unitLabel: "Slide",
    formatName: "PowerPoint",
    emptyHint: "",
  },
};
const BINARY_EXTENSIONS = Object.keys(BINARY_EXTRACTORS);

const SUPPORTED_EXTENSIONS = [...TEXT_EXTENSIONS, ...BINARY_EXTENSIONS];

// Generous for plain text (a few thousand pages' worth) while still
// catching an accidental paste of something enormous.
const MAX_TEXT_CONTENT_BYTES = 2 * 1024 * 1024;

// PDFs and PPTX decks run much bigger than plain text (embedded
// fonts/images/media), so this gets its own, larger ceiling — 25MB
// comfortably covers a real lecture slide deck while still catching an
// accidental upload of something absurd. Kept well under the JSON body
// limit index.js sets for this route (the base64-encoded payload is
// ~33% bigger than the raw file).
export const MAX_BINARY_CONTENT_BYTES = 25 * 1024 * 1024;

// A sanity ceiling against unbounded growth (e.g. a scripting accident),
// not a product opinion about how much material a subject "should" have —
// a full semester course is nowhere near this many files. One cap per
// subject across every content type (text, paste, and binary uploads
// alike), not a separate counter per format.
const MAX_CONTENT_ITEMS_PER_SUBJECT = 200;

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, []);
}

export function contentDirsFor(appDataDir, subjectId) {
  const base = path.join(appDataSubdirs(appDataDir).content, subjectId);
  return { raw: path.join(base, "raw"), parsed: path.join(base, "parsed") };
}

/** Where a content item's extracted text lives on disk — parsed files are
 * always named `<id>.md` regardless of the original extension (see
 * `ingest` below), so topic extraction can find them without duplicating
 * this naming rule. */
export function parsedFilePath(appDataDir, contentItem) {
  return path.join(contentDirsFor(appDataDir, contentItem.subjectId).parsed, `${contentItem.id}.md`);
}

function extensionOf(filename) {
  return path.extname(filename).toLowerCase();
}

export async function listContent(appDataDir, subjectId) {
  const all = await storeFor(appDataDir).read();
  return all.filter((c) => c.subjectId === subjectId);
}

/** Builds the parsed markdown for a binary content item from its
 * extractor's per-unit strings (one page for PDF, one slide for PPTX):
 * one `## <unitLabel> N` section per unit (any `UNRELIABLE_EXTRACTION_
 * MARKER` the extractor already prepended travels with its unit's
 * text), so the model turn that later reads this file sees unit
 * boundaries and the same inline flags a human reading it would. Pure,
 * exported for its own test. */
export function buildParsedText(units, unitLabel) {
  return units.map((text, i) => `## ${unitLabel} ${i + 1}\n\n${text}`.trimEnd()).join("\n\n");
}

// Kept as a thin wrapper — existing callers/tests already name this one
// specifically for PDF.
export function buildPdfParsedText(pages) {
  return buildParsedText(pages, "Page");
}

async function ingestBinary(appDataDir, subjectId, { ext, fileBuffer, trimmedName, source }) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new Error("Content is empty");
  }
  const sizeBytes = fileBuffer.length;
  if (sizeBytes > MAX_BINARY_CONTENT_BYTES) {
    throw new Error(`File is too large (${sizeBytes} bytes; limit is ${MAX_BINARY_CONTENT_BYTES} bytes)`);
  }

  const existingCount = (await listContent(appDataDir, subjectId)).length;
  if (existingCount >= MAX_CONTENT_ITEMS_PER_SUBJECT) {
    throw new Error(`Subject already has the maximum of ${MAX_CONTENT_ITEMS_PER_SUBJECT} content items`);
  }

  const id = randomUUID();
  const dirs = contentDirsFor(appDataDir, subjectId);
  await fs.mkdir(dirs.raw, { recursive: true });
  await fs.mkdir(dirs.parsed, { recursive: true });

  const rawPath = path.join(dirs.raw, `${id}${ext}`);
  const parsedPath = path.join(dirs.parsed, `${id}.md`);
  await fs.writeFile(rawPath, fileBuffer);

  const { extract, unitsKey, unreliableKey, unitLabel, formatName, emptyHint } = BINARY_EXTRACTORS[ext];
  let result;
  try {
    result = await extract(rawPath);
  } catch (err) {
    // Don't leave an orphan raw file behind for an upload that never
    // became a usable content item.
    await fs.unlink(rawPath).catch(() => {});
    throw new Error(`Couldn't read this ${formatName} file: ${err.message ?? err}`);
  }
  const units = result[unitsKey];
  const unreliableUnitNumbers = result[unreliableKey];

  const parsedText = buildParsedText(units, unitLabel);
  // A unit with no usable text (e.g. a title slide) is fine; a file with
  // NO extractable text on ANY unit is treated the same as "Content is
  // empty" for a text upload, rather than silently stored as an
  // unusable, permanently-empty content item.
  if (!units.some((u) => u.trim())) {
    await fs.unlink(rawPath).catch(() => {});
    throw new Error(`No extractable text found in this ${formatName} file${emptyHint}`);
  }
  await fs.writeFile(parsedPath, parsedText, "utf8");

  const record = {
    id,
    subjectId,
    originalFilename: trimmedName,
    extension: ext,
    source,
    sizeBytes,
    addedAt: new Date().toISOString(),
    // Set once topic extraction has looked at this item's parsed text
    // (topicExtraction.js) — null means "still queued".
    topicsExtractedAt: null,
    // 1-based page/slide numbers pageLooksUnreliable (shared by
    // pdfExtract.js and pptxExtract.js) flagged as likely garbled/
    // undecoded — [] (not omitted) when every unit looked fine, so a
    // caller can check `.length` without an existence check. Flagged
    // units are still ingested (their text may still be partially
    // useful, and topic extraction already sees the same inline warning
    // the extractor prepended) — never silently dropped, just marked.
    // Named `unreliablePages` (not `unreliableUnits`) for both formats —
    // this field predates PPTX support and the UI/API already key off
    // this exact name (see api.ts's ContentItem type).
    unreliablePages: unreliableUnitNumbers,
  };
  await storeFor(appDataDir).update((current) => [...current, record]);
  return record;
}

async function ingestText(appDataDir, subjectId, { ext, text, trimmedName, source }) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Content is empty");
  }

  const sizeBytes = Buffer.byteLength(text, "utf8");
  if (sizeBytes > MAX_TEXT_CONTENT_BYTES) {
    throw new Error(`Content is too large (${sizeBytes} bytes; limit is ${MAX_TEXT_CONTENT_BYTES} bytes)`);
  }

  const existingCount = (await listContent(appDataDir, subjectId)).length;
  if (existingCount >= MAX_CONTENT_ITEMS_PER_SUBJECT) {
    throw new Error(`Subject already has the maximum of ${MAX_CONTENT_ITEMS_PER_SUBJECT} content items`);
  }

  const id = randomUUID();
  const dirs = contentDirsFor(appDataDir, subjectId);
  await fs.mkdir(dirs.raw, { recursive: true });
  await fs.mkdir(dirs.parsed, { recursive: true });

  const rawPath = path.join(dirs.raw, `${id}${ext}`);
  const parsedPath = path.join(dirs.parsed, `${id}.md`);
  // Identity extraction: plain text/markdown has nothing to decode, so raw
  // and parsed are the same bytes.
  await fs.writeFile(rawPath, text, "utf8");
  await fs.writeFile(parsedPath, text, "utf8");

  const record = {
    id,
    subjectId,
    originalFilename: trimmedName,
    extension: ext,
    source,
    sizeBytes,
    addedAt: new Date().toISOString(),
    topicsExtractedAt: null,
    unreliablePages: [],
  };
  await storeFor(appDataDir).update((current) => [...current, record]);
  return record;
}

/** `text` is for plain-text formats; `fileBuffer` (a Buffer of raw bytes)
 * is for binary formats (currently just PDF) — exactly one applies,
 * selected by `ext`. */
async function ingest(appDataDir, subjectId, { filename, text, fileBuffer, source }) {
  const trimmedName = typeof filename === "string" ? filename.trim() : "";
  if (!trimmedName) throw new Error("Filename is required");

  const ext = extensionOf(trimmedName);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Unsupported file type "${ext || "(no extension)"}" — only ${SUPPORTED_EXTENSIONS.join(", ")} are supported right now`,
    );
  }

  if (BINARY_EXTENSIONS.includes(ext)) {
    return ingestBinary(appDataDir, subjectId, { ext, fileBuffer, trimmedName, source });
  }
  return ingestText(appDataDir, subjectId, { ext, text, trimmedName, source });
}

/** `contentBase64` (a base64-encoded string of the raw file bytes) is for
 * binary formats (currently just PDF); `text` is for plain-text formats.
 * The route decides which one it got from the request body — this just
 * decodes and passes it through. */
export function addUploadedContent(appDataDir, subjectId, { filename, text, contentBase64 }) {
  const fileBuffer = typeof contentBase64 === "string" ? Buffer.from(contentBase64, "base64") : undefined;
  return ingest(appDataDir, subjectId, { filename, text, fileBuffer, source: "upload" });
}

export function addPastedNotes(appDataDir, subjectId, { text }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return ingest(appDataDir, subjectId, { filename: `pasted-notes-${stamp}.md`, text, source: "paste" });
}

/** Marks the given content items as having had topics extracted
 * (topicExtraction.js, after a successful batch). Ids not found are
 * silently ignored — a content item deleted mid-scan (no delete endpoint
 * exists yet, but nothing here should assume one never will) just leaves
 * nothing to update. */
export async function markTopicsExtracted(appDataDir, contentIds) {
  if (!contentIds.length) return;
  const idSet = new Set(contentIds);
  const now = new Date().toISOString();
  await storeFor(appDataDir).update((current) => current.map((c) => (idSet.has(c.id) ? { ...c, topicsExtractedAt: now } : c)));
}

/**
 * Removes one content item (the user picked the wrong file, or a
 * duplicate) and its raw + parsed copies. File paths are built from the
 * stored record's own id/extension, never from request input, so nothing
 * outside this subject's content dirs can be touched. Topics already
 * found from it stay: they aren't linked to a single item. Returns the
 * removed record, or null if there was no such item in this subject.
 */
export async function removeContent(appDataDir, subjectId, contentId) {
  let removed = null;
  await storeFor(appDataDir).update((current) => {
    removed = current.find((c) => c.id === contentId && c.subjectId === subjectId) ?? null;
    return removed ? current.filter((c) => c !== removed) : current;
  });
  if (!removed) return null;
  const dirs = contentDirsFor(appDataDir, subjectId);
  await fs.unlink(path.join(dirs.raw, `${removed.id}${removed.extension}`)).catch(() => {});
  await fs.unlink(path.join(dirs.parsed, `${removed.id}.md`)).catch(() => {});
  return removed;
}
