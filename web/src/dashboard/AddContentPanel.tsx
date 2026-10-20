import { useEffect, useRef, useState } from "react";
import {
  addPastedNotes,
  listContent,
  removeContent,
  MAX_UPLOAD_BYTES,
  uploadBinaryContent,
  uploadTextContent,
  type ContentItem,
} from "./api";
import { confirmContentRemoval } from "./contentRemoval";
import { ContentFileList } from "./ContentFileList";
import { useEscapeKey } from "../useEscapeKey";
import { useFocusTrap } from "../useFocusTrap";

// Add content (SPEC.md section 7): a native file picker (plain
// text/markdown, now also PDF and PPTX — server/src/pdfExtract.js /
// pptxExtract.js) plus a "paste class notes" text box. Binary formats
// are sent as raw bytes (api.ts's uploadBinaryContent); text formats are
// read and sent as-is. "Done"
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
  const [dragOver, setDragOver] = useState(false);

  // Escape (and the Close button) leave without looking for topics; any
  // new content stays unread until Done is used next time.
  // Not while busy, and not with typed-but-unsaved notes (Escape would
  // silently throw them away).
  useEscapeKey(onClose, !busy && !notes.trim());
  const dialogRef = useRef<HTMLElement>(null);
  useFocusTrap(dialogRef);

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
        if (file.size > MAX_UPLOAD_BYTES) {
          problems.push(`${file.name}: too big (${Math.round(file.size / 1024 / 1024)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB per file)`);
          continue;
        }
        setUploadingName(files.length > 1 ? `${file.name} (${index + 1} of ${files.length})` : file.name);
        try {
          if (BINARY_EXTENSIONS.includes(ext)) {
            await uploadBinaryContent(subjectId, file);
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
    if (!(await confirmContentRemoval(subjectId, item))) return;
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
      <section className="content-panel modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="content-panel-title">
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

        {/* A drop zone instead of the browser's bare file input. The real
            input stays inside (visually hidden) so clicking and keyboard
            focus still open the native picker. */}
        <label
          className={`content-drop${dragOver ? " content-drop-active" : ""}${busy ? " content-drop-disabled" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const files = Array.from(e.dataTransfer.files ?? []);
            if (!busy && files.length) handleFiles(files);
          }}
        >
          <input
            className="visually-hidden"
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
          <span className="content-drop-title">Drop files here, or click to choose</span>
          <span className="content-drop-hint">PDF, PowerPoint (.pptx), text or Markdown. Several at once is fine.</span>
        </label>

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
        {items !== null && <ContentFileList items={items} busy={busy} onRemove={remove} />}
      </section>
    </div>
  );
}
