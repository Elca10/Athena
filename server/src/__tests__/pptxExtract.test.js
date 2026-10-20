import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { extractPptxSlides } from "../pptxExtract.js";
import { UNRELIABLE_EXTRACTION_MARKER } from "../pdfExtract.js";
import { makeTempDir } from "../testHelpers/tempDir.js";

async function scratchDir() {
  return makeTempDir("athena-pptx-extract-");
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PRESENTATION_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** One `<a:p>` paragraph made of the given run texts (each its own
 * `<a:r><a:t>`, concatenated by a real PPTX reader with no separator —
 * exactly what this fixture is for testing). */
function paragraphXml(runTexts) {
  // Real PowerPoint always marks <a:t> xml:space="preserve" (significant
  // for runs with leading/trailing spaces, e.g. "Hello " before another
  // run) -- also exercises textOf()'s object-shaped-node branch, since
  // ignoreAttributes:false turns an attribute-bearing <a:t> into
  // `{ "@_xml:space": ..., "#text": ... }` rather than a plain string.
  const runs = runTexts.map((t) => `<a:r><a:t xml:space="preserve">${escapeXml(t)}</a:t></a:r>`).join("");
  return `<a:p>${runs}</a:p>`;
}

/** A `<p:sp>` text-box shape containing one `<a:p>` per entry in
 * `paragraphs` (each entry either a plain string -> one run, or an array
 * of strings -> multiple runs in that one paragraph). */
function textShapeXml(paragraphs, { placeholderType } = {}) {
  const ph = placeholderType ? `<p:nvPr><p:ph type="${placeholderType}"/></p:nvPr>` : "<p:nvPr/>";
  const body = paragraphs.map((p) => paragraphXml(Array.isArray(p) ? p : [p])).join("");
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="TextBox"/><p:cNvSpPr/>${ph}</p:nvSpPr>` +
    `<p:txBody>${body}</p:txBody></p:sp>`
  );
}

/** A `<p:sp>` containing an `<a:fld>` (computed field, e.g. slide number)
 * instead of a real run — used to confirm fields are excluded the same
 * way python-pptx's `paragraph.runs` excludes them. */
function fieldOnlyShapeXml(fieldText) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="SlideNumber"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:txBody><a:p><a:fld id="{00000000-0000-0000-0000-000000000000}" type="slidenum">` +
    `<a:t>${escapeXml(fieldText)}</a:t></a:fld></a:p></p:txBody></p:sp>`
  );
}

/** A `<p:grpSp>` wrapping a nested `<p:sp>` with real text — used to
 * confirm a grouped shape's own nested shapes are never descended into
 * (see pptxExtract.js's module comment). */
function groupWithNestedTextXml(nestedText) {
  return (
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr/>${textShapeXml([nestedText])}</p:grpSp>`
  );
}

function slideXml(shapesXml) {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:sld ${PRESENTATION_NS}><p:cSld><p:spTree>${shapesXml.join("")}</p:spTree></p:cSld></p:sld>`
  );
}

function notesSlideXml(bodyParagraphs) {
  const imagePlaceholder =
    '<p:sp><p:nvSpPr><p:cNvPr id="1" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:txBody/></p:sp>';
  const body = textShapeXml(bodyParagraphs, { placeholderType: "body" });
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:notes ${PRESENTATION_NS}><p:cSld><p:spTree>${imagePlaceholder}${body}</p:spTree></p:cSld></p:notes>`
  );
}

function relsXml(entries) {
  const rels = entries
    .map(
      ({ id, type, target }) =>
        `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
  );
}

/**
 * Builds a minimal (but real) .pptx zip buffer. `slideDefs` is given in
 * the LOGICAL (presentation) order the test wants extraction to produce;
 * each entry is `{ shapesXml: string[], file?: string, notes?: string[][] }`
 * where `file` (default `slideN.xml` for its position in `slideDefs`) is
 * the on-disk part name — tests that want to prove slide order follows
 * `presentation.xml` rather than filename order pass mismatched `file`s.
 * Deliberately skips `[Content_Types].xml` and the package-level
 * `_rels/.rels` — real PowerPoint always writes them, but nothing in
 * pptxExtract.js reads either (it resolves `ppt/presentation.xml`
 * directly), so they'd be fixture noise with no test value here.
 */
function buildPptxBuffer(slideDefs) {
  const zip = new AdmZip();

  const sldIds = [];
  const presRels = [];
  slideDefs.forEach((def, i) => {
    const file = def.file ?? `slide${i + 1}.xml`;
    const rid = `rId${i + 1}`;
    sldIds.push(`<p:sldId id="${256 + i}" r:id="${rid}"/>`);
    presRels.push({
      id: rid,
      type: REL_SLIDE,
      target: `slides/${file}`,
    });

    zip.addFile(`ppt/slides/${file}`, Buffer.from(slideXml(def.shapesXml), "utf8"));

    if (def.notes) {
      const notesFile = `notesSlide${i + 1}.xml`;
      zip.addFile(`ppt/notesSlides/${notesFile}`, Buffer.from(notesSlideXml(def.notes), "utf8"));
      zip.addFile(
        `ppt/slides/_rels/${file}.rels`,
        Buffer.from(relsXml([{ id: "rId1", type: REL_NOTES_SLIDE, target: `../notesSlides/${notesFile}` }]), "utf8"),
      );
    }
  });

  const presentationXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:presentation ${PRESENTATION_NS}><p:sldIdLst>${sldIds.join("")}</p:sldIdLst></p:presentation>`;
  zip.addFile("ppt/presentation.xml", Buffer.from(presentationXml, "utf8"));
  zip.addFile("ppt/_rels/presentation.xml.rels", Buffer.from(relsXml(presRels), "utf8"));

  return zip.toBuffer();
}

const REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_NOTES_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

async function writeSamplePptx(filePath, slideDefs) {
  await fs.writeFile(filePath, buildPptxBuffer(slideDefs));
}

test("extractPptxSlides: one string per slide, runs within a paragraph joined with no separator", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "sample.pptx");
  await writeSamplePptx(filePath, [
    { shapesXml: [textShapeXml([["Hello ", "World"], "Second paragraph on slide one."])] },
    { shapesXml: [textShapeXml(["Slide two body text about the history of the subject."])] },
  ]);

  const { slides, unreliableSlideNumbers } = await extractPptxSlides(filePath);
  assert.equal(slides.length, 2);
  assert.equal(slides[0], "Hello World\nSecond paragraph on slide one.");
  assert.match(slides[1], /history of the subject/);
  assert.deepEqual(unreliableSlideNumbers, []);
});

test("extractPptxSlides: decodes XML entities back to literal characters", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "sample.pptx");
  await writeSamplePptx(filePath, [{ shapesXml: [textShapeXml(["Alice & Bob < Carol"])] }]);

  const { slides } = await extractPptxSlides(filePath);
  assert.equal(slides[0], "Alice & Bob < Carol");
});

test("extractPptxSlides: excludes computed fields and grouped shapes' nested text", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "sample.pptx");
  await writeSamplePptx(filePath, [
    {
      shapesXml: [
        textShapeXml(["Real body text."]),
        fieldOnlyShapeXml("3"),
        groupWithNestedTextXml("Text hidden inside a group"),
      ],
    },
  ]);

  const { slides } = await extractPptxSlides(filePath);
  assert.equal(slides[0], "Real body text.");
  assert.doesNotMatch(slides[0], /hidden inside a group/);
});

test("extractPptxSlides: appends speaker notes from the notes body placeholder only", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "sample.pptx");
  await writeSamplePptx(filePath, [
    {
      shapesXml: [textShapeXml(["Slide content."])],
      notes: ["Remember to mention the exam date.", "And the office hours change."],
    },
    { shapesXml: [textShapeXml(["Second slide, no notes."])] },
  ]);

  const { slides } = await extractPptxSlides(filePath);
  assert.equal(
    slides[0],
    "Slide content.\n[Speaker notes] Remember to mention the exam date.\nAnd the office hours change.",
  );
  assert.equal(slides[1], "Second slide, no notes.");
});

test("extractPptxSlides: slide order follows presentation.xml, not slideN.xml filenames", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "sample.pptx");
  // Deliberately mismatched: logical slide 1 lives in slide3.xml, logical
  // slide 2 in slide1.xml, logical slide 3 in slide2.xml -- mirrors a
  // deck reordered in PowerPoint, which keeps each slide's original
  // filename.
  await writeSamplePptx(filePath, [
    { file: "slide3.xml", shapesXml: [textShapeXml(["First logically, stored as slide3.xml."])] },
    { file: "slide1.xml", shapesXml: [textShapeXml(["Second logically, stored as slide1.xml."])] },
    { file: "slide2.xml", shapesXml: [textShapeXml(["Third logically, stored as slide2.xml."])] },
  ]);

  const { slides } = await extractPptxSlides(filePath);
  assert.equal(slides.length, 3);
  assert.match(slides[0], /First logically/);
  assert.match(slides[1], /Second logically/);
  assert.match(slides[2], /Third logically/);
});

test("extractPptxSlides: flags a garbled slide the same way pdfExtract.js flags a garbled PDF page", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "sample.pptx");
  const garbled = Array.from({ length: 50 }, (_, i) => `xqvbk${i}`).join(" ");
  await writeSamplePptx(filePath, [
    { shapesXml: [textShapeXml(["Perfectly normal slide with the usual common English words."])] },
    { shapesXml: [textShapeXml([garbled])] },
  ]);

  const { slides, unreliableSlideNumbers } = await extractPptxSlides(filePath);
  assert.doesNotMatch(slides[0], /EXTRACTION UNRELIABLE/);
  assert.ok(slides[1].startsWith(UNRELIABLE_EXTRACTION_MARKER));
  assert.deepEqual(unreliableSlideNumbers, [2]);
});

test("extractPptxSlides: a blank slide (no text anywhere) is an empty string, not an error", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "sample.pptx");
  await writeSamplePptx(filePath, [{ shapesXml: [] }]);

  const { slides, unreliableSlideNumbers } = await extractPptxSlides(filePath);
  assert.deepEqual(slides, [""]);
  assert.deepEqual(unreliableSlideNumbers, []);
});

test("extractPptxSlides: rejects a file that isn't a zip archive at all", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "not-a-pptx.pptx");
  await fs.writeFile(filePath, "this is plain text, not a zip");

  await assert.rejects(() => extractPptxSlides(filePath), /valid \.pptx file/);
});

test("extractPptxSlides: rejects a zip that's missing ppt/presentation.xml", async () => {
  const dir = await scratchDir();
  const filePath = path.join(dir, "empty.pptx");
  const zip = new AdmZip();
  zip.addFile("README.txt", Buffer.from("not a real deck"));
  await fs.writeFile(filePath, zip.toBuffer());

  await assert.rejects(() => extractPptxSlides(filePath), /missing ppt\/presentation\.xml/);
});
