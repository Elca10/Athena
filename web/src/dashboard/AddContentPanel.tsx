import { useEffect, useRef, useState } from "react";
import {
  addPastedNotes,
  listContent,
  removeContent,
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
// saves any notes still in the box, closes the panel, and hands the slow
// part (reading for topics, writing practice questions — see
// readNewContent.ts) to the dashboard via onDone, which shows progress and
// the result there. The panel used to stay open, blocking everything, for
// the minute or two those model turns take.
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
  onDone,
}: {
  subjectId: string;
  subjectName: string;
  onClose: () => void;
  onContentAdded?: () => void;
  /** Called (just before closing) when Done leaves unread content to read. */
  onDone?: () => void;
}) {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Escape (and the Close button) leave without looking for topics; any
  // new content stays unread until Done is used next time.
  // Not while busy, and not with typed-but-unsaved notes (Escape would
  // silently throw them away).
  useEscapeKey(onClose, !busy && !notes.trim());

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

  // Several files can be picked at once; they're added one after another,
  // and one bad file doesn't stop the rest.
  async function handleFiles(files: File[]) {
    setError(null);
    setBusy(true);
    const problems: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        const ext = extensionOf(file.name);
        if (!ACCEPTED_EXTENSIONS.includes(ext)) {
          problems.push(`${file.name}: unsupported file type (only ${ACCEPTED_EXTENSIONS.join(", ")})`);
          continue;
        }
        setUploadingName(files.length > 1 ? `${file.name} (${index + 1} of ${files.length})` : file.name);
        try {
          if (BINARY_EXTENSIONS.includes(ext)) {
            await uploadBinaryContent(subjectId, file.name, await readAsBase64(file));
          } else {
            await uploadTextContent(subjectId, file.name, await readAsText(file));
          }
        } catch (err) {
          problems.push(`${file.name}: ${err instanceof Error ? err.message : "couldn't add it"}`);
        }
      }
      await refresh();
      onContentAdded?.();
    } finally {
      setBusy(false);
      setUploadingName(null);
      if (problems.length) setError(problems.join(" · "));
    }
  }

  async function remove(item: ContentItem) {
    const extra = item.topicsExtractedAt ? " Topics already found from it will stay." : "";
    if (!window.confirm(`Remove "${item.originalFilename}"?${extra}`)) return;
    setError(null);
    setBusy(true);
    try {
      await removeContent(subjectId, item.id);
      await refresh();
      onContentAdded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove that item.");
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

  // Done = save any notes still in the box (they used to be dropped
  // silently), then close. If anything is unread, the dashboard reads it
  // in the background (onDone) — skipped when nothing is, so Done on an
  // untouched panel doesn't start a pointless turn.
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
    if (current.some((item) => !item.topicsExtractedAt)) onDone?.();
    onClose();
  }

  return (
    <div className="modal-backdrop">
      <section className="content-panel modal" role="dialog" aria-modal="true" aria-labelledby="content-panel-title">
        <div className="content-panel-header">
          <h2 id="content-panel-title">Add content — {subjectName}</h2>
          <div className="content-panel-header-actions">
            <button type="button" onClick={closePanel} disabled={busy}>
              Close
            </button>
            <button type="button" className="btn-primary" onClick={finishAdding} disabled={busy}>
              Done
            </button>
          </div>
        </div>

        <div className="content-panel-upload">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS.join(",")}
            disabled={busy}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) handleFiles(files);
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
            disabled={busy}
          />
          <button type="submit" className="btn-secondary" disabled={busy || !notes.trim()}>
            Add notes
          </button>
        </form>

        {uploadingName && (
          <div className="content-panel-status" role="status">
            Adding {uploadingName}… (a long PDF or slide deck can take a minute)
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
                    <span className="content-panel-item-side">
                      <span className="content-panel-item-status">{item.topicsExtractedAt ? "Read" : "Not read yet"}</span>
                      <button
                        type="button"
                        className="content-panel-remove"
                        onClick={() => remove(item)}
                        disabled={busy}
                        aria-label={`Remove ${item.originalFilename}`}
                      >
                        Remove
                      </button>
                    </span>
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
