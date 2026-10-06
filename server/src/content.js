// Content ingestion (SPEC.md section 7): the "Add content" flow for a
// subject, plus the "paste class notes" text box. This build step handles
// plain text/markdown only — for those formats the local, no-network,
// no-model extraction step is the identity transform (there's nothing to
// decode), so raw and parsed end up as the same text, just filed under a
// deterministic id-based name. PDF/PPTX support (which needs real
// extraction plus the garbled-text detection a comparable parser
// elsewhere already built) and topic extraction (the one background
// model turn that reads newly parsed files) are their own later
// build-13-step-2 sub-steps — this module only gets content onto disk
// and recorded.
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

const FILE_NAME = "content.json";

// Plain-text formats this build step can ingest. Anything else (PDF,
// PPTX, DOCX, ...) is rejected with a clear "not yet supported" error
// rather than stored but never parsed.
const SUPPORTED_EXTENSIONS = [".txt", ".md", ".markdown"];

// Generous for plain text (a few thousand pages' worth) while still
// catching an accidental paste of something enormous. PDF/PPTX will need
// their own, likely larger, limit when that support lands.
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

// A sanity ceiling against unbounded growth (e.g. a scripting accident),
// not a product opinion about how much material a subject "should"
// have — a full semester course is nowhere near this many files.
const MAX_CONTENT_ITEMS_PER_SUBJECT = 200;

function storeFor(appDataDir) {
  return makeJsonFileStore(appDataSubdirs(appDataDir).db, FILE_NAME, []);
}

function contentDirsFor(appDataDir, subjectId) {
  const base = path.join(appDataSubdirs(appDataDir).content, subjectId);
  return { raw: path.join(base, "raw"), parsed: path.join(base, "parsed") };
}

function extensionOf(filename) {
  return path.extname(filename).toLowerCase();
}

export async function listContent(appDataDir, subjectId) {
  const all = await storeFor(appDataDir).read();
  return all.filter((c) => c.subjectId === subjectId);
}

async function ingest(appDataDir, subjectId, { filename, text, source }) {
  const trimmedName = typeof filename === "string" ? filename.trim() : "";
  if (!trimmedName) throw new Error("Filename is required");

  const ext = extensionOf(trimmedName);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Unsupported file type "${ext || "(no extension)"}" — only ${SUPPORTED_EXTENSIONS.join(", ")} are supported right now`,
    );
  }

  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Content is empty");
  }

  const sizeBytes = Buffer.byteLength(text, "utf8");
  if (sizeBytes > MAX_CONTENT_BYTES) {
    throw new Error(`Content is too large (${sizeBytes} bytes; limit is ${MAX_CONTENT_BYTES} bytes)`);
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
  // and parsed are the same bytes. Writing both still keeps the pipeline's
  // shape uniform for when PDF/PPTX (where they genuinely differ) lands.
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
  };
  await storeFor(appDataDir).update((current) => [...current, record]);
  return record;
}

export function addUploadedContent(appDataDir, subjectId, { filename, text }) {
  return ingest(appDataDir, subjectId, { filename, text, source: "upload" });
}

export function addPastedNotes(appDataDir, subjectId, { text }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return ingest(appDataDir, subjectId, { filename: `pasted-notes-${stamp}.md`, text, source: "paste" });
}
