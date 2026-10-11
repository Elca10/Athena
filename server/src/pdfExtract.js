// PDF text extraction (SPEC.md section 7, priority queue item 3, first
// piece) — pulls raw text out of a PDF, one string per page, for the
// content-ingestion pipeline content.js will eventually call into. PPTX
// support and wiring this into content.js's `ingest()` are separate later
// steps (see content.js's own header comment).
//
// Node, not bundled Python (SPEC.md section 11's decision) — pdfjs-dist is
// pure JavaScript with prebuilt WASM only for optional image codecs we
// never touch here, so Windows needs no system Python/poppler/etc.
//
// Ports the garbled/undecodable-text detection from a comparable local
// PDF/PPTX parser's `_page_looks_unreliable()` almost line-for-line —
// same thresholds, same reasoning: two real-world extraction bugs found
// against real lecture-slide downloads (word-gluing and undecoded-glyph
// garbage). `pageLooksUnreliable` below is a pure string function with
// no PDF dependency, deliberately, so it stays testable without needing
// real/synthetic PDF files — same design principle the original parser
// calls out explicitly.
//
// One thing that does NOT carry over: pdfplumber's "word-gluing" bug (the
// Python module's x_tolerance_ratio fix) is specific to pdfplumber
// reconstructing words from individual character positions. pdfjs-dist's
// getTextContent() instead returns already-shaped text runs taken from
// the PDF's own text-showing operators, so adjacent runs on the same line
// are the more likely place gluing could happen (if a PDF's content
// stream positions two runs side by side with no literal space
// character). joinLineItems() below applies the same gap-vs-font-size
// idea defensively at that level — not a reproduction of the exact
// Python bug, since pdfjs's extraction strategy doesn't appear to hit it
// in practice, but cheap insurance against the same failure mode.

import { readFile } from "node:fs/promises";

// (cid:N) is pdfminer/pdfjs's tell that a glyph had no usable ToUnicode
// entry in the PDF's embedded font subset — see module comment above.
const CID_MARKER_PATTERN = /\(cid:\d+\)/g;

const COMMON_ENGLISH_WORDS = new Set([
  "the", "and", "of", "to", "a", "in", "is", "for", "that", "on",
  "with", "this", "as", "are", "be", "or", "an", "it", "by", "from",
  "at", "we", "you",
]);

// Ported thresholds — see extractors.py for the full reasoning behind
// each exact value (real bugs found against real Canvas downloads).
const UNRELIABLE_MIN_WORDS = 40;
const UNRELIABLE_MIN_COMMON_WORD_FRACTION = 0.02;
const UNRELIABLE_MIN_CID_DENSITY = 0.15;

// Gap between two text items on the same line, as a fraction of font
// size, above which a separating space is inserted when joining them —
// see module comment's "word-gluing" note. Reuses the Python version's
// chosen ratio (same semantics: gap/font-size), not a re-derivation.
const X_TOLERANCE_RATIO = 0.1;

export const UNRELIABLE_EXTRACTION_MARKER =
  "⚠️ EXTRACTION UNRELIABLE — this page's text layer looks " +
  "broken (undecoded glyphs or garbled/mis-decoded characters). Read the " +
  "source PDF directly instead of trusting this extracted text.";

/** True if `text` (one page's raw extracted text) looks like it came
 * from a broken font mapping rather than genuine content. Direct port of
 * extractors.py's `_page_looks_unreliable()` — see that file for the
 * full history of why these particular thresholds were chosen. */
export function pageLooksUnreliable(text) {
  const cidMarkers = text.match(CID_MARKER_PATTERN) ?? [];
  const withoutCidMarkers = text.replace(CID_MARKER_PATTERN, " ");
  const words = withoutCidMarkers.match(/[A-Za-z]+/g) ?? [];
  const totalTokens = words.length + cidMarkers.length;

  if (totalTokens < UNRELIABLE_MIN_WORDS) {
    return cidMarkers.length > 0;
  }

  if (cidMarkers.length > 0 && cidMarkers.length / totalTokens >= UNRELIABLE_MIN_CID_DENSITY) {
    return true;
  }

  if (words.length === 0) return false;
  const commonCount = words.filter((word) => COMMON_ENGLISH_WORDS.has(word.toLowerCase())).length;
  return commonCount / words.length < UNRELIABLE_MIN_COMMON_WORD_FRACTION;
}

/** Joins the text items of a single PDF text line (as returned by
 * pdfjs-dist's getTextContent(), already split into lines by `hasEOL`)
 * into one string, inserting a space between two items only when the
 * horizontal gap between them is wide enough — relative to font size —
 * to plausibly be a real word boundary rather than an artifact of how
 * the PDF happened to chunk its text runs. See module comment. */
function joinLineItems(items) {
  let result = "";
  let prevEndX = null;
  for (const item of items) {
    if (!item.str) continue;
    const fontSize = Math.abs(item.transform[3]) || Math.abs(item.transform[0]) || 1;
    const startX = item.transform[4];
    if (prevEndX !== null) {
      const gapRatio = (startX - prevEndX) / fontSize;
      if (gapRatio > X_TOLERANCE_RATIO && !/\s$/.test(result) && !/^\s/.test(item.str)) {
        result += " ";
      }
    }
    result += item.str;
    prevEndX = startX + item.width;
  }
  return result.trim();
}

/** Groups a page's flat `textContent.items` array into lines (pdfjs-dist
 * marks the last item of each line with `hasEOL: true`) and joins each
 * line via `joinLineItems`, preserving line breaks. */
function joinPageItems(items) {
  const lines = [];
  let current = [];
  for (const item of items) {
    current.push(item);
    if (item.hasEOL) {
      lines.push(current);
      current = [];
    }
  }
  if (current.length) lines.push(current);
  return lines
    .map(joinLineItems)
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Returns one raw text string per page of the PDF at `filePath`. Pages
 * whose text looks unreliable (see `pageLooksUnreliable`) get
 * `UNRELIABLE_EXTRACTION_MARKER` prepended; a single warning naming the
 * file and affected page numbers is logged via `console.warn` if any
 * page was flagged — mirrors extractors.py's `extract_pdf_pages()`. */
export async function extractPdfPages(filePath) {
  // Imported lazily (not at module load) so modules that only need
  // `pageLooksUnreliable` (e.g. its own unit tests) never pay for
  // pdfjs-dist's worker/font setup.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = await readFile(filePath);
  // `destroy()` lives on the loading task, not the resolved document
  // proxy (easy to mix up — pdfjs-dist's own docs/examples vary on this).
  const loadingTask = getDocument({ data: new Uint8Array(data), useSystemFonts: true });
  const doc = await loadingTask.promise;

  const pages = [];
  const unreliablePageNumbers = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let text = joinPageItems(textContent.items);
      if (pageLooksUnreliable(text)) {
        unreliablePageNumbers.push(pageNumber);
        text = `${UNRELIABLE_EXTRACTION_MARKER}\n\n${text}`;
      }
      pages.push(text);
    }
  } finally {
    await loadingTask.destroy();
  }

  if (unreliablePageNumbers.length) {
    console.warn(
      `WARNING: ${filePath}: extraction looks unreliable on page(s) ` +
        `${unreliablePageNumbers.join(", ")} (a large fraction of undecoded glyphs, ` +
        `or too few common English words) — read the source PDF directly for those ` +
        `pages instead of trusting this output.`,
    );
  }

  return pages;
}
