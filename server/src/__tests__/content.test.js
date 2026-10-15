import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import AdmZip from "adm-zip";
import { listContent, addUploadedContent, addPastedNotes, buildPdfParsedText, MAX_BINARY_CONTENT_BYTES } from "../content.js";
import { appDataSubdirs } from "../dataDir.js";
import { makeJsonFileStore } from "../store/jsonFileStore.js";

const PRESENTATION_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Builds a minimal (but real) .pptx buffer with one slide per entry in
 * `slideTexts` (falsy for a blank slide, exercising "no extractable
 * text" the same way `samplePdfBuffer`'s `null` pages do below) — same
 * zip+XML technique pptxExtract.test.js uses for its own, more detailed
 * fixtures, trimmed down here since this file only needs a real, valid
 * deck to drive through `ingest()`, not to exercise pptxExtract.js's own
 * structural edge cases (covered there). */
function samplePptxBuffer(slideTexts) {
  const zip = new AdmZip();
  const sldIds = [];
  const rels = [];
  slideTexts.forEach((text, i) => {
    const rid = `rId${i + 1}`;
    sldIds.push(`<p:sldId id="${256 + i}" r:id="${rid}"/>`);
    rels.push(
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    );
    const body = text
      ? `<p:sp><p:nvSpPr><p:cNvPr id="2" name="TextBox"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
      : "";
    const slideXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<p:sld ${PRESENTATION_NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
    zip.addFile(`ppt/slides/slide${i + 1}.xml`, Buffer.from(slideXml, "utf8"));
  });
  const presentationXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:presentation ${PRESENTATION_NS}><p:sldIdLst>${sldIds.join("")}</p:sldIdLst></p:presentation>`;
  zip.addFile("ppt/presentation.xml", Buffer.from(presentationXml, "utf8"));
  const relsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  zip.addFile("ppt/_rels/presentation.xml.rels", Buffer.from(relsXml, "utf8"));
  return zip.toBuffer();
}

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-content-"));
}

/** Generates a real multi-page PDF with pdfkit (never committed — written
 * fresh into a scratch tmpdir per test, same technique as
 * pdfExtract.test.js) and returns it as a Buffer, ready to pass as
 * the upload route would carry it over the wire. */
async function samplePdfBuffer(pages) {
  const dir = await scratchDir();
  const filePath = path.join(dir, "sample.pdf");
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = createWriteStream(filePath);
    doc.pipe(stream);
    for (const pageText of pages) {
      doc.addPage();
      if (pageText) doc.fontSize(12).text(pageText);
    }
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return fs.readFile(filePath);
}

test("listContent starts empty for any subject id", async () => {
  const dir = await scratchDir();
  assert.deepEqual(await listContent(dir, "subject-1"), []);
});

test("addUploadedContent accepts .md, writes raw+parsed files, and records metadata", async () => {
  const dir = await scratchDir();
  const record = await addUploadedContent(dir, "subject-1", {
    filename: "Lecture 1.md",
    text: "# Lecture 1\n\nSome notes.",
  });

  assert.equal(record.subjectId, "subject-1");
  assert.equal(record.originalFilename, "Lecture 1.md");
  assert.equal(record.extension, ".md");
  assert.equal(record.source, "upload");
  assert.equal(record.sizeBytes, Buffer.byteLength("# Lecture 1\n\nSome notes.", "utf8"));
  assert.equal(typeof record.id, "string");
  assert.equal(typeof record.addedAt, "string");
  assert.deepEqual(await listContent(dir, "subject-1"), [record]);

  const dirs = appDataSubdirs(dir);
  const rawPath = path.join(dirs.content, "subject-1", "raw", `${record.id}.md`);
  const parsedPath = path.join(dirs.content, "subject-1", "parsed", `${record.id}.md`);
  assert.equal(await fs.readFile(rawPath, "utf8"), "# Lecture 1\n\nSome notes.");
  assert.equal(await fs.readFile(parsedPath, "utf8"), "# Lecture 1\n\nSome notes.");
});

test("addUploadedContent accepts .txt the same way", async () => {
  const dir = await scratchDir();
  const record = await addUploadedContent(dir, "subject-1", { filename: "notes.txt", text: "plain text" });
  assert.equal(record.extension, ".txt");
});

test("addUploadedContent rejects a missing filename", async () => {
  const dir = await scratchDir();
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "", text: "hi" }),
    /filename is required/i,
  );
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { text: "hi" }),
    /filename is required/i,
  );
});

test("addUploadedContent rejects an unsupported file type and stores nothing", async () => {
  // .docx, not .pptx -- PPTX is a supported binary format now.
  const dir = await scratchDir();
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "notes.docx", text: "whatever" }),
    /unsupported file type/i,
  );
  assert.deepEqual(await listContent(dir, "subject-1"), []);
});

test("addUploadedContent rejects a filename with no extension", async () => {
  const dir = await scratchDir();
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "README", text: "whatever" }),
    /unsupported file type/i,
  );
});

test("addUploadedContent rejects blank or missing text", async () => {
  const dir = await scratchDir();
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "notes.txt", text: "   " }),
    /content is empty/i,
  );
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "notes.txt" }),
    /content is empty/i,
  );
});

test("addUploadedContent rejects text over the size limit", async () => {
  const dir = await scratchDir();
  const tooBig = "a".repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "huge.txt", text: tooBig }),
    /too large/i,
  );
  assert.deepEqual(await listContent(dir, "subject-1"), []);
});

test("addUploadedContent enforces the per-subject item count limit", async () => {
  const dir = await scratchDir();
  const dirs = appDataSubdirs(dir);
  const store = makeJsonFileStore(dirs.db, "content.json", []);
  const seeded = Array.from({ length: 200 }, (_, i) => ({
    id: `seed-${i}`,
    subjectId: "subject-1",
    originalFilename: `seed-${i}.txt`,
    extension: ".txt",
    source: "upload",
    sizeBytes: 1,
    addedAt: new Date().toISOString(),
  }));
  await store.write(seeded);

  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "one-more.txt", text: "hi" }),
    /maximum of 200/i,
  );
  assert.equal((await listContent(dir, "subject-1")).length, 200);

  // A different subject is unaffected by subject-1's count.
  const record = await addUploadedContent(dir, "subject-2", { filename: "fine.txt", text: "hi" });
  assert.equal(record.subjectId, "subject-2");
});

test("addPastedNotes generates a .md filename and tags the source as paste", async () => {
  const dir = await scratchDir();
  const record = await addPastedNotes(dir, "subject-1", { text: "stuff I learned today" });
  assert.equal(record.source, "paste");
  assert.equal(record.extension, ".md");
  assert.match(record.originalFilename, /^pasted-notes-.+\.md$/);

  const dirs = appDataSubdirs(dir);
  const parsedPath = path.join(dirs.content, "subject-1", "parsed", `${record.id}.md`);
  assert.equal(await fs.readFile(parsedPath, "utf8"), "stuff I learned today");
});

test("addPastedNotes rejects blank text", async () => {
  const dir = await scratchDir();
  await assert.rejects(() => addPastedNotes(dir, "subject-1", { text: "  " }), /content is empty/i);
});

test("addUploadedContent never collides on id across concurrent calls", async () => {
  const dir = await scratchDir();
  const created = await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      addUploadedContent(dir, "subject-1", { filename: `f${i}.txt`, text: `text ${i}` }),
    ),
  );
  const ids = new Set(created.map((c) => c.id));
  assert.equal(ids.size, 15);
  assert.equal((await listContent(dir, "subject-1")).length, 15);
});

// --- PDF ingestion: real PDF binaries, generated fresh per test (never
// committed). fileBuffer is how the upload route carries
// raw binary bytes over JSON. ---

test("buildPdfParsedText joins pages under '## Page N' headings", () => {
  assert.equal(buildPdfParsedText(["first", "second"]), "## Page 1\n\nfirst\n\n## Page 2\n\nsecond");
});

test("addUploadedContent accepts a real .pdf, extracts text, and records no unreliable pages", async () => {
  const dir = await scratchDir();
  const rawBytes = await samplePdfBuffer([
    "The quick brown fox jumps over the lazy dog and the cat too.",
    "Page two has different content about the history of the subject.",
  ]);

  const record = await addUploadedContent(dir, "subject-1", {
    filename: "Lecture 1.pdf",
    fileBuffer: rawBytes,
  });

  assert.equal(record.extension, ".pdf");
  assert.equal(record.source, "upload");
  assert.equal(record.sizeBytes, rawBytes.length);
  assert.deepEqual(record.unreliablePages, []);

  const dirs = appDataSubdirs(dir);
  const rawPath = path.join(dirs.content, "subject-1", "raw", `${record.id}.pdf`);
  const parsedPath = path.join(dirs.content, "subject-1", "parsed", `${record.id}.md`);
  // Raw file on disk is the exact original binary, not re-encoded/altered.
  assert.deepEqual(await fs.readFile(rawPath), rawBytes);
  const parsedText = await fs.readFile(parsedPath, "utf8");
  assert.match(parsedText, /## Page 1/);
  assert.match(parsedText, /quick brown fox/);
  assert.match(parsedText, /## Page 2/);
  assert.match(parsedText, /history of the subject/);
});

test("addUploadedContent flags a PDF's unreliable pages without dropping them", async () => {
  const dir = await scratchDir();
  const brokenPage = Array.from({ length: 60 }, (_, i) => `(cid:${i})`).join(" ");
  const rawBytes = await samplePdfBuffer([
    "This is a perfectly normal page with the usual common English words.",
    brokenPage,
  ]);

  const record = await addUploadedContent(dir, "subject-1", {
    filename: "Lecture 2.pdf",
    fileBuffer: rawBytes,
  });

  assert.deepEqual(record.unreliablePages, [2]);
  const dirs = appDataSubdirs(dir);
  const parsedText = await fs.readFile(path.join(dirs.content, "subject-1", "parsed", `${record.id}.md`), "utf8");
  // The flagged page's text is still present (not dropped), just marked.
  assert.match(parsedText, /EXTRACTION UNRELIABLE/);
  assert.match(parsedText, /cid:0/);
});

test("addUploadedContent rejects a PDF with no extractable text on any page, and leaves no raw file behind", async () => {
  const dir = await scratchDir();
  const rawBytes = await samplePdfBuffer([null, null]); // two blank pages, no text at all

  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "scanned.pdf", fileBuffer: rawBytes }),
    /no extractable text/i,
  );
  assert.deepEqual(await listContent(dir, "subject-1"), []);
  const dirs = appDataSubdirs(dir);
  assert.deepEqual(await fs.readdir(path.join(dirs.content, "subject-1", "raw")).catch(() => []), []);
});

test("addUploadedContent rejects a PDF over the binary size limit and stores nothing", async () => {
  const dir = await scratchDir();
  // Doesn't need a real oversized PDF (slow to generate and pointless —
  // the size check runs before any attempt to parse it) — any buffer over
  // the limit exercises the same guard.
  const tooBig = Buffer.alloc(MAX_BINARY_CONTENT_BYTES + 1, 1);

  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "huge.pdf", fileBuffer: tooBig }),
    /too large/i,
  );
  assert.deepEqual(await listContent(dir, "subject-1"), []);
});

test("addUploadedContent rejects a .pdf upload with no file content", async () => {
  const dir = await scratchDir();
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "empty.pdf" }),
    /content is empty/i,
  );
  assert.deepEqual(await listContent(dir, "subject-1"), []);
});

test("addUploadedContent rejects a corrupt .pdf (not a real PDF) and leaves no raw file behind", async () => {
  const dir = await scratchDir();
  const notAPdf = Buffer.from("this is not a pdf file at all, just plain bytes");

  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "fake.pdf", fileBuffer: notAPdf }),
    /couldn't read this pdf/i,
  );
  assert.deepEqual(await listContent(dir, "subject-1"), []);
  const dirs = appDataSubdirs(dir);
  assert.deepEqual(await fs.readdir(path.join(dirs.content, "subject-1", "raw")).catch(() => []), []);
});

test("addUploadedContent accepts a real .pptx, extracts text, and records no unreliable slides", async () => {
  const dir = await scratchDir();
  const rawBytes = samplePptxBuffer([
    "The quick brown fox jumps over the lazy dog and the cat too.",
    "Slide two has different content about the history of the subject.",
  ]);

  const record = await addUploadedContent(dir, "subject-1", {
    filename: "Lecture 1.pptx",
    fileBuffer: rawBytes,
  });

  assert.equal(record.extension, ".pptx");
  assert.equal(record.source, "upload");
  assert.equal(record.sizeBytes, rawBytes.length);
  assert.deepEqual(record.unreliablePages, []);

  const dirs = appDataSubdirs(dir);
  const rawPath = path.join(dirs.content, "subject-1", "raw", `${record.id}.pptx`);
  const parsedPath = path.join(dirs.content, "subject-1", "parsed", `${record.id}.md`);
  // Raw file on disk is the exact original binary, not re-encoded/altered.
  assert.deepEqual(await fs.readFile(rawPath), rawBytes);
  const parsedText = await fs.readFile(parsedPath, "utf8");
  assert.match(parsedText, /## Slide 1/);
  assert.match(parsedText, /quick brown fox/);
  assert.match(parsedText, /## Slide 2/);
  assert.match(parsedText, /history of the subject/);
});

test("addUploadedContent flags a PPTX's unreliable slides without dropping them", async () => {
  const dir = await scratchDir();
  const garbled = Array.from({ length: 50 }, (_, i) => `xqvbk${i}`).join(" ");
  const rawBytes = samplePptxBuffer(["This is a perfectly normal slide with the usual common English words.", garbled]);

  const record = await addUploadedContent(dir, "subject-1", {
    filename: "Lecture 2.pptx",
    fileBuffer: rawBytes,
  });

  assert.deepEqual(record.unreliablePages, [2]);
  const dirs = appDataSubdirs(dir);
  const parsedText = await fs.readFile(path.join(dirs.content, "subject-1", "parsed", `${record.id}.md`), "utf8");
  // The flagged slide's text is still present (not dropped), just marked.
  assert.match(parsedText, /EXTRACTION UNRELIABLE/);
  assert.match(parsedText, /xqvbk0/);
});

test("addUploadedContent rejects a PPTX with no extractable text on any slide, and leaves no raw file behind", async () => {
  const dir = await scratchDir();
  const rawBytes = samplePptxBuffer([null, null]); // two blank slides, no text at all

  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "blank.pptx", fileBuffer: rawBytes }),
    /no extractable text/i,
  );
  assert.deepEqual(await listContent(dir, "subject-1"), []);
  const dirs = appDataSubdirs(dir);
  assert.deepEqual(await fs.readdir(path.join(dirs.content, "subject-1", "raw")).catch(() => []), []);
});

test("addUploadedContent rejects a corrupt .pptx (not a real zip) and leaves no raw file behind", async () => {
  const dir = await scratchDir();
  const notAPptx = Buffer.from("this is not a pptx file at all, just plain bytes");

  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "fake.pptx", fileBuffer: notAPptx }),
    /couldn't read this powerpoint file/i,
  );
  assert.deepEqual(await listContent(dir, "subject-1"), []);
  const dirs = appDataSubdirs(dir);
  assert.deepEqual(await fs.readdir(path.join(dirs.content, "subject-1", "raw")).catch(() => []), []);
});

test("a PDF upload counts toward the same per-subject item limit as text uploads", async () => {
  const dir = await scratchDir();
  const dirs = appDataSubdirs(dir);
  const store = makeJsonFileStore(dirs.db, "content.json", []);
  const seeded = Array.from({ length: 200 }, (_, i) => ({
    id: `seed-${i}`,
    subjectId: "subject-1",
    originalFilename: `seed-${i}.txt`,
    extension: ".txt",
    source: "upload",
    sizeBytes: 1,
    addedAt: new Date().toISOString(),
  }));
  await store.write(seeded);

  const rawBytes = await samplePdfBuffer(["one more page of real content for this subject"]);
  await assert.rejects(
    () => addUploadedContent(dir, "subject-1", { filename: "one-more.pdf", fileBuffer: rawBytes }),
    /maximum of 200/i,
  );
});

test("removeContent deletes the item and its raw + parsed files, only within its own subject", async () => {
  const { removeContent, contentDirsFor } = await import("../content.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-content-remove-"));
  const item = await addUploadedContent(dir, "s1", { filename: "wrong.md", text: "oops" });
  const keep = await addUploadedContent(dir, "s1", { filename: "right.md", text: "keep" });
  const dirs = contentDirsFor(dir, "s1");

  assert.equal(await removeContent(dir, "other-subject", item.id), null, "another subject can't remove it");
  assert.equal((await removeContent(dir, "s1", item.id)).id, item.id);
  assert.deepEqual((await listContent(dir, "s1")).map((c) => c.id), [keep.id]);
  await assert.rejects(fs.access(path.join(dirs.raw, `${item.id}.md`)));
  await assert.rejects(fs.access(path.join(dirs.parsed, `${item.id}.md`)));
  await fs.access(path.join(dirs.parsed, `${keep.id}.md`));
  assert.equal(await removeContent(dir, "s1", item.id), null);
});
