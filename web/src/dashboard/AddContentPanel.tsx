import { useEffect, useRef, useState } from "react";
import {
  addPastedNotes,
  listContent,
  scanTopics,
  uploadBinaryContent,
  uploadTextContent,
  type ContentItem,
} from "./api";

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
}: {
  subjectId: string;
  subjectName: string;
  onClose: () => void;
  onContentAdded?: () => void;
}) {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  async function finishAdding() {
    const hasUnprocessed = items?.some((item) => !item.topicsExtractedAt) ?? false;
    if (!hasUnprocessed) {
      onClose();
      return;
    }
    setError(null);
    setScanning(true);
    try {
      const result = await scanTopics(subjectId);
      if (result.errors.length) {
        setError(`Looked for topics, but: ${result.errors.join("; ")}`);
        return;
      }
      onContentAdded?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't look for topics in your new files.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="content-panel modal">
        <div className="content-panel-header">
          <h2>Add content — {subjectName}</h2>
          <button type="button" className="btn-primary" onClick={finishAdding} disabled={scanning}>
            {scanning ? "Looking for topics…" : "Done"}
          </button>
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

        {error && <div className="content-panel-error">{error}</div>}

        {items === null && <div className="dashboard-empty">Loading…</div>}
        {items?.length === 0 && <div className="dashboard-empty">No content added yet.</div>}
        {items !== null && items.length > 0 && (
          <ul className="content-panel-list">
            {items.map((item) => {
              const unreliableNote = formatUnreliableNote(item);
              return (
                <li key={item.id}>
                  <span>{item.originalFilename}</span>
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
