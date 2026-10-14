import { useEffect, useRef, useState } from "react";
import {
  addPastedNotes,
  listContent,
  scanBank,
  scanTopics,
  uploadBinaryContent,
  uploadTextContent,
  type ContentItem,
} from "./api";
import { useEscapeKey } from "../useEscapeKey";

// Add content (SPEC.md section 7): a native file picker (plain
// text/markdown, now also PDF and PPTX — server/src/pdfExtract.js /
// pptxExtract.js) plus a "paste class notes" text box. Binary formats
// are read client-side and base64-encoded (see api.ts's
// uploadBinaryContent); text formats are read and sent as-is. "Done"
// runs the background topic-extraction turn (topics.js's /scan route)
// over whatever content hasn't been scanned yet before closing — there's
// still no Active-session progress UI for this to report into (SPEC.md's
// "shows progress as an Active session" is a later build step), so it's
// a plain disable-and-wait with the result/error shown inline.
const BINARY_EXTENSIONS = [".pdf", ".pptx"];
const ACCEPTED_EXTENSIONS = [".txt", ".md", ".markdown", ...BINARY_EXTENSIONS];

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read that file"));
    reader.readAsText(file);
  });
}

// Encodes a File's raw bytes as base64 without ever materializing a
// giant arg list for String.fromCharCode (which blows the call stack
// well under this app's own MAX_BINARY_CONTENT_BYTES) — chunked the same
// way this conversion is commonly done for large binaries in the browser.
async function readAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

// `unreliablePages` holds 1-based page numbers for a PDF, slide numbers
// for a PPTX (same field name for both — see content.js's record
// comment); word it to match so a PPTX's note doesn't say "page".
function formatUnreliableNote(item: ContentItem): string | null {
  if (!item.unreliablePages.length) return null;
  const unit = item.extension === ".pptx" ? "slide" : "page";
  const label = item.unreliablePages.length === 1 ? unit : `${unit}s`;
  return `⚠️ extraction looked unreliable on ${label} ${item.unreliablePages.join(", ")} — check the source file`;
}

export function AddContentPanel({
  subjectId,
  subjectName,
  onClose,
  onContentAdded,
  onFinished,
}: {
  subjectId: string;
  subjectName: string;
  onClose: () => void;
  onContentAdded?: () => void;
  /** Called with a one-line summary after Done finishes reading content. */
  onFinished?: (summary: string) => void;
}) {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanStage, setScanStage] = useState<"topics" | "questions">("topics");
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Escape (and the Close button) leave without looking for topics; any
  // new content stays unread until Done is used next time.
  // Not while busy, and not with typed-but-unsaved notes (Escape would
  // silently throw them away).
  useEscapeKey(onClose, !busy && !scanning && !notes.trim());

  function closePanel() {
    if (notes.trim() && !window.confirm("Discard the notes you typed but haven't added?")) return;
    onClose();
  }

  async function refresh() {
    setItems(await listContent(subjectId));
  }

  useEffect(() => {
    refresh();
  }, [subjectId]);

  async function handleFile(file: File) {
    const ext = extensionOf(file.name);
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setError(`Unsupported file type "${ext || "(no extension)"}" — only ${ACCEPTED_EXTENSIONS.join(", ")} are supported right now`);
      return;
    }
    setError(null);
    setBusy(true);
    setUploadingName(file.name);
    try {
      if (BINARY_EXTENSIONS.includes(ext)) {
        await uploadBinaryContent(subjectId, file.name, await readAsBase64(file));
      } else {
        await uploadTextContent(subjectId, file.name, await readAsText(file));
      }
      await refresh();
      onContentAdded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that file.");
    } finally {
      setBusy(false);
      setUploadingName(null);
    }
  }

  async function submitNotes() {
    const trimmed = notes.trim();
    if (!trimmed) return;
    setError(null);
    setBusy(true);
    try {
      await addPastedNotes(subjectId, trimmed);
      setNotes("");
      await refresh();
      onContentAdded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add those notes.");
    } finally {
      setBusy(false);
    }
  }

  // Closes the panel once any newly-added content has been scanned for
  // topics. Skips the scan entirely when nothing is unprocessed (e.g. the
  // user opened the panel and added nothing, or everything in it was
  // already scanned before) so "Done" doesn't wait on a pointless turn.
  // Done = save any notes still in the box (they used to be dropped
  // silently), read new content for topics, then write practice questions
  // for those topics so a Ready session works straight away, and report
  // what happened.
  async function finishAdding() {
    setError(null);
    let current = items ?? [];
    if (notes.trim()) {
      setBusy(true);
      try {
        await addPastedNotes(subjectId, notes.trim());
        setNotes("");
        current = await listContent(subjectId);
        setItems(current);
        onContentAdded?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add those notes.");
        return;
      } finally {
        setBusy(false);
      }
    }
    const unread = current.filter((item) => !item.topicsExtractedAt).length;
    if (!unread) {
      onClose();
      return;
    }
    setScanning(true);
    setScanStage("topics");
    try {
      const topics = await scanTopics(subjectId);
      if (topics.errors.length) {
        setError(`Looked for topics, but: ${topics.errors.join("; ")}`);
        return;
      }
      setScanStage("questions");
      let questionsNote = "";
      try {
        const bank = await scanBank(subjectId);
        if (bank.errors.length) questionsNote = " Some practice questions couldn't be written yet; Athena will offer to try again when you study.";
      } catch {
        questionsNote = " Practice questions couldn't be written yet; Athena will offer to try again when you study.";
      }
      onContentAdded?.();
      const found =
        topics.topicsAdded === 0
          ? `Read ${unread} new item${unread === 1 ? "" : "s"} for ${subjectName}, but found no new topics.`
          : `Found ${topics.topicsAdded} new topic${topics.topicsAdded === 1 ? "" : "s"} in ${subjectName}. Ready to study.`;
      onFinished?.(found + questionsNote);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't look for topics in your new files.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="content-panel modal" role="dialog" aria-modal="true" aria-labelledby="content-panel-title">
        <div className="content-panel-header">
          <h2 id="content-panel-title">Add content — {subjectName}</h2>
          <div className="content-panel-header-actions">
            <button type="button" onClick={closePanel} disabled={busy || scanning}>
              Close
            </button>
            <button type="button" className="btn-primary" onClick={finishAdding} disabled={scanning || busy}>
              {scanning ? (scanStage === "topics" ? "Finding topics…" : "Writing practice questions…") : "Done"}
            </button>
          </div>
        </div>

        <div className="content-panel-upload">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(",")}
            disabled={busy || scanning}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) handleFile(file);
            }}
          />
        </div>

        <form
          className="content-panel-notes"
          onSubmit={(e) => {
            e.preventDefault();
            submitNotes();
          }}
        >
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Paste class notes or a summary of what you learned…"
            rows={3}
            disabled={busy || scanning}
          />
          <button type="submit" className="btn-secondary" disabled={busy || scanning || !notes.trim()}>
            Add notes
          </button>
        </form>

        {uploadingName && (
          <div className="content-panel-status" role="status">
            Adding {uploadingName}… (a long PDF or slide deck can take a minute)
          </div>
        )}
        {scanning && (
          <div className="content-panel-status" role="status">
            {scanStage === "topics"
              ? "Athena is reading your content to find the topics. This can take a minute or two."
              : "Writing practice questions for the new topics. Almost there."}
          </div>
        )}
        {error && <div className="content-panel-error">{error}</div>}

        {items === null && <div className="dashboard-empty">Loading…</div>}
        {items?.length === 0 && <div className="dashboard-empty">No content added yet.</div>}
        {items !== null && items.length > 0 && (
          <ul className="content-panel-list">
            {items.map((item) => {
              const unreliableNote = formatUnreliableNote(item);
              return (
                <li key={item.id}>
                  <span className="content-panel-item">
                    <span>{item.originalFilename}</span>
                    <span className="content-panel-item-status">{item.topicsExtractedAt ? "Read" : "Not read yet"}</span>
                  </span>
                  {unreliableNote && <span className="content-panel-unreliable">{unreliableNote}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
