// PPTX text extraction (SPEC.md section 7, priority queue item 3) — pulls
// raw text out of a PowerPoint deck's slides (and speaker notes), one
// string per slide, for the content-ingestion pipeline. Sibling to
// pdfExtract.js; wired into content.js's `ingest()` for the ".pptx"
// extension the same way PDF was.
//
// Node, not bundled Python (SPEC.md section 11's decision): a .pptx is a
// zip of XML parts (OOXML), so this needs a zip reader and an XML parser,
// not a PDF-specific library. `adm-zip` (pure JS, zero dependencies of
// its own) reads the zip container; `fast-xml-parser` (pure JS, one small
// transitive dependency, `strnum`) parses each part's XML. Both chosen
// over hand-rolled regex-on-XML, which breaks on escaped entities
// (`&amp;`), self-closing tags, and attribute-bearing text nodes (see
// `textOf` below) in ways a real parser doesn't — same reasoning
// pdfExtract.js's own header comment gives for picking a real library
// over DIY parsing.
//
// Dependency-version note: kept on fast-xml-parser's 4.x line rather than
// the vulnerability-patched 5.x. The one known advisory against <5.7.0
// (GHSA-gh4j-gqv2-49f6) is in XMLBuilder, which this module never imports
// or calls — only XMLParser, which that advisory doesn't touch. `adm-zip`
// IS kept current (0.6.1): its advisories (zip-bomb memory DoS,
// symlink-following extraction, SUID-bit preservation on extraction) are
// read-path issues a crafted or corrupted uploaded .pptx could actually
// trigger here, unlike the XMLBuilder-only fast-xml-parser one.
//
// Applies the same garbled-text flagging pdfExtract.js uses
// (`pageLooksUnreliable`, imported and reused directly rather than
// copied) to each slide's text. PPTX text runs are literal XML content,
// so they can never actually produce pdfminer/pdfjs's `(cid:N)`
// undecoded-glyph markers the way an embedded PDF font subset can — but
// the common-English-word-fraction half of that check is format-agnostic
// and still catches genuinely garbled/mis-decoded text if it ever occurs,
// and reusing it keeps the `unreliable*Numbers`-shaped result consistent
// across both formats for content.js and the UI to treat uniformly.
//
// What this ports from python-pptx's object model (the reference parser
// this is a port of used python-pptx, not hand-rolled XML either — see
// its own module docstring):
// - Slide order follows the deck's own authoritative order
//   (ppt/presentation.xml's <p:sldIdLst>, resolved through
//   ppt/_rels/presentation.xml.rels), not slideN.xml filename order —
//   those two only reliably agree until slides are reordered in
//   PowerPoint, which keeps each slide's original filename.
// - Only direct top-level shapes in a slide's shape tree are read (never
//   descends into a grouped shape's own nested shapes) — matches
//   python-pptx's `slide.shapes`, which the reference parser iterated
//   directly with no group recursion of its own.
// - Only `<a:r>` (run) text is read; `<a:fld>` (computed fields — slide
//   number, date) and `<a:br>` (line breaks) are not runs and are
//   skipped, matching python-pptx's `paragraph.runs`.
// - Speaker notes come from the notes slide's own body placeholder only
//   (`<p:ph type="body">`, or an untyped `<p:ph>` which defaults to
//   "body" per OOXML), not every shape on the notes slide (which also
//   holds a slide-image placeholder, and sometimes slide-number/date
//   placeholders) — matches python-pptx's
//   `notes_slide.notes_text_frame`.

import { readFile } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { pageLooksUnreliable, UNRELIABLE_EXTRACTION_MARKER } from "./pdfExtract.js";

const REL_TYPE_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_TYPE_NOTES_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

// `trimValues: false` matters here, not just stylistically: fast-xml-
// parser trims leading/trailing whitespace off tag text content by
// default, which would silently eat a trailing space at the end of an
// `<a:t>` run — exactly the kind of word-gluing bug this module's header
// comment (and pdfExtract.js's) already worries about for the PDF side.
// Real PowerPoint XML usually marks `<a:t>` with `xml:space="preserve"`
// for the same reason, but this doesn't rely on every producer setting
// it correctly.
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: false });

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Text content of a parsed XML leaf node — usually a plain string, but
 * becomes `{ "@_...": ..., "#text": ... }` when the source element (e.g.
 * `<a:t xml:space="preserve">`) carried attributes, since this module
 * parses with `ignoreAttributes: false` (needed elsewhere, for
 * relationship ids and placeholder types). */
function textOf(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object") return String(node["#text"] ?? "");
  return "";
}

function readZipText(zip, entryName) {
  const entry = zip.getEntry(entryName);
  if (!entry) return null;
  return entry.getData().toString("utf8");
}

function parseXml(xml) {
  return xmlParser.parse(xml);
}

/** Relationship id -> `{ target, type }` for a `.rels` part (e.g.
 * `ppt/_rels/presentation.xml.rels`) — `target` is resolved to a
 * zip-entry-style path relative to `baseDir` (the directory the `.rels`
 * part's own subject part lives in), the same way a browser resolves a
 * relative URL against its document's own location. */
function parseRels(xml, baseDir) {
  const map = new Map();
  if (!xml) return map;
  const rels = toArray(parseXml(xml)?.Relationships?.Relationship);
  for (const rel of rels) {
    const id = rel["@_Id"];
    const target = rel["@_Target"];
    if (!id || !target) continue;
    // OOXML targets are almost always relative ("slides/slide1.xml",
    // "../notesSlides/notesSlide1.xml"); it also allows an explicit
    // "/ppt/..." absolute form, which path.posix.join would otherwise
    // mis-resolve relative to baseDir.
    const resolved = target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(baseDir, target));
    map.set(id, { target: resolved, type: rel["@_Type"] });
  }
  return map;
}

/** The deck's slide parts, in the deck's own authoritative order (see
 * module comment) — never slideN.xml filename order. */
function orderedSlidePaths(zip) {
  const presentationXml = readZipText(zip, "ppt/presentation.xml");
  if (!presentationXml) throw new Error("Not a valid .pptx file (missing ppt/presentation.xml)");
  const sldIds = toArray(parseXml(presentationXml)?.["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"]);

  const rels = parseRels(readZipText(zip, "ppt/_rels/presentation.xml.rels"), "ppt");

  const slidePaths = [];
  for (const sldId of sldIds) {
    const rel = rels.get(sldId["@_r:id"]);
    if (rel && rel.type === REL_TYPE_SLIDE) slidePaths.push(rel.target);
  }
  return slidePaths;
}

/** All `<a:t>` text within one paragraph's own `<a:r>` runs, concatenated
 * with no separator (matching python-pptx's
 * `"".join(run.text for run in paragraph.runs)`) — `<a:fld>`/`<a:br>`
 * siblings are not runs and are deliberately not read here. */
function paragraphRunText(paragraph) {
  return toArray(paragraph?.["a:r"])
    .map((run) => textOf(run?.["a:t"]))
    .join("");
}

/** One line per non-blank paragraph of a shape's text frame, in document
 * order — a shape with no `<p:txBody>` at all (a picture, a connector)
 * has no text frame and contributes nothing. */
function shapeTextLines(shape) {
  return toArray(shape?.["p:txBody"]?.["a:p"])
    .map(paragraphRunText)
    .filter((text) => text.trim().length > 0);
}

/** Every top-level shape directly in a slide's (or notes slide's) shape
 * tree — `<p:sp>` only; pictures/graphic frames/connectors never carry a
 * text frame, and a grouped shape's own nested shapes are deliberately
 * not descended into (see module comment). */
function topLevelShapes(sldOrNotesRoot) {
  return toArray(sldOrNotesRoot?.["p:cSld"]?.["p:spTree"]?.["p:sp"]);
}

/** A shape's placeholder type (`<p:nvSpPr><p:nvPr><p:ph type="...">`), or
 * `undefined` if the shape isn't a placeholder at all. Per OOXML, a
 * `<p:ph>` with no `type` attribute defaults to type "body" — common for
 * a notes slide's actual notes placeholder. */
function placeholderType(shape) {
  const ph = shape?.["p:nvSpPr"]?.["p:nvPr"]?.["p:ph"];
  if (ph === undefined) return undefined;
  return ph["@_type"] ?? "body";
}

/** The notes slide's own body placeholder text (type "body"), its
 * paragraphs joined with "\n" — matches python-pptx's
 * `notes_slide.notes_text_frame.text`, specifically that one placeholder
 * rather than every shape on the notes slide (see module comment). "" if
 * no body placeholder is found. */
function notesBodyText(notesRoot) {
  const bodyShape = topLevelShapes(notesRoot).find((shape) => placeholderType(shape) === "body");
  return bodyShape ? shapeTextLines(bodyShape).join("\n") : "";
}

/** `partPath`'s own `.rels` part path — e.g. "ppt/slides/slide1.xml" ->
 * "ppt/slides/_rels/slide1.xml.rels" — OOXML's fixed convention for where
 * a part's relationships live. */
function relsPathFor(partPath) {
  return path.posix.join(path.posix.dirname(partPath), "_rels", `${path.posix.basename(partPath)}.rels`);
}

/** One slide's speaker notes text, via its own `.rels` -> notesSlide
 * relationship — "" if the slide has no notes slide at all (most slides
 * don't). */
function notesTextForSlide(zip, slidePath) {
  const relsXml = readZipText(zip, relsPathFor(slidePath));
  if (!relsXml) return "";
  const rels = parseRels(relsXml, path.posix.dirname(slidePath));
  const notesRel = [...rels.values()].find((rel) => rel.type === REL_TYPE_NOTES_SLIDE);
  if (!notesRel) return "";

  const notesXml = readZipText(zip, notesRel.target);
  if (!notesXml) return "";
  return notesBodyText(parseXml(notesXml)?.["p:notes"]).trim();
}

/** One slide's full text: every text-frame shape's paragraphs, each its
 * own line, in document order, followed by a single `"[Speaker notes]
 * ..."` line if the slide has non-empty notes — matches the reference
 * parser's `extract_pptx_slides()` exactly, including that trailing
 * single-line notes convention rather than notes getting their own
 * per-paragraph lines. */
function slideText(zip, slidePath) {
  const slideXml = readZipText(zip, slidePath);
  if (!slideXml) throw new Error(`Missing slide part: ${slidePath}`);
  const slideRoot = parseXml(slideXml)?.["p:sld"];

  const lines = topLevelShapes(slideRoot).flatMap(shapeTextLines);
  const notes = notesTextForSlide(zip, slidePath);
  if (notes) lines.push(`[Speaker notes] ${notes}`);
  return lines.join("\n");
}

/** Returns `{ slides, unreliableSlideNumbers }` for the PPTX at
 * `filePath`: `slides` is one raw text string per slide (deck order, see
 * module comment), each with speaker notes appended as a trailing line.
 * Slides whose text looks unreliable (`pageLooksUnreliable`, shared with
 * pdfExtract.js) get `UNRELIABLE_EXTRACTION_MARKER` prepended AND their
 * 1-based slide number collected into `unreliableSlideNumbers` — same
 * shape and caller contract as `extractPdfPages()`'s return value, so
 * content.js can treat both formats uniformly. A single warning naming
 * the file and affected slide numbers is also logged via `console.warn`
 * if any slide was flagged, mirroring pdfExtract.js's own. */
export async function extractPptxSlides(filePath) {
  const data = await readFile(filePath);
  let zip;
  try {
    zip = new AdmZip(data);
  } catch (err) {
    throw new Error(`Not a valid .pptx file (couldn't open as a zip archive): ${err.message ?? err}`);
  }

  const slidePaths = orderedSlidePaths(zip);
  const slides = [];
  const unreliableSlideNumbers = [];
  for (let i = 0; i < slidePaths.length; i++) {
    let text = slideText(zip, slidePaths[i]);
    if (pageLooksUnreliable(text)) {
      unreliableSlideNumbers.push(i + 1);
      text = `${UNRELIABLE_EXTRACTION_MARKER}\n\n${text}`;
    }
    slides.push(text);
  }

  if (unreliableSlideNumbers.length) {
    console.warn(
      `WARNING: ${filePath}: extraction looks unreliable on slide(s) ` +
        `${unreliableSlideNumbers.join(", ")} (a large fraction of undecoded glyphs, ` +
        `or too few common English words) — read the source PPTX directly for those ` +
        `slides instead of trusting this output.`,
    );
  }

  return { slides, unreliableSlideNumbers };
}
