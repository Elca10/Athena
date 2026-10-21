import { useEffect, useState } from "react";
import { getBigIdeas, setBigIdeas, type BigIdeas } from "./api";

// Big ideas (SPEC-v2.md section 3's structure-building row / SPEC.md
// section 6: a per-subject "big ideas" summary the USER writes and
// revises themselves — Make It Stick's point is building it yourself, so
// there's no "generate" button here and no model call anywhere on this
// path). Shared between SubjectDetailPanel's own section (view/edit,
// started by clicking "Edit" or the empty state's "Add big ideas") and
// StudyFlow's post-session prompt (`autoEdit`: the "Revise" click IS the
// edit-mode entry, so there's no separate view mode to show first).
//
// Server's own length cap (server/src/bigIdeas.js's MAX_BIG_IDEAS_CHARS)
// isn't imported here — the web and server packages don't share modules —
// but is mirrored as a `maxLength` on the textarea so the user sees the
// limit before hitting a save error, not after.
const MAX_BIG_IDEAS_CHARS = 4000;

export function BigIdeasEditor({
  subjectId,
  compact = false,
  autoEdit = false,
  onDirtyChange,
  onSaved,
  onCancelAutoEdit,
}: {
  subjectId: string;
  /** StudyFlow's post-session prompt uses a smaller textarea and skips the
   * section-style wrapper SubjectDetailPanel gives this. */
  compact?: boolean;
  /** Mounts straight into edit mode — the post-session prompt's "Revise"
   * button is itself the "start editing" click, so there's no separate
   * view-mode step to show first. */
  autoEdit?: boolean;
  /** Fires whenever there's a typed-but-unsaved edit, so a parent modal
   * can gate its own Close/Escape the same way AddContentPanel already
   * does for its pasted-notes box — typed text is never silently
   * discarded. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Only meaningful with `autoEdit`: called after a successful save, so
   * the post-session prompt can move on (next subject, or finish) instead
   * of sitting on a now-saved editor with nothing left to do. */
  onSaved?: () => void;
  /** Only meaningful with `autoEdit`: Cancel here means "back to the
   * yes/no prompt for this subject", not "show a view mode" — there isn't
   * one in that context. */
  onCancelAutoEdit?: () => void;
}) {
  const [data, setData] = useState<BigIdeas | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  async function refresh() {
    setLoadError(null);
    try {
      const next = await getBigIdeas(subjectId);
      // A malformed/missing response (e.g. a test harness that blanket-
      // mocks `./api` without stubbing this one call) is a load failure,
      // not a crash — same posture as every other section's own fetch.
      if (!next || typeof next.text !== "string") throw new Error("malformed big ideas response");
      setData(next);
      if (autoEdit) setDraft(next.text);
    } catch {
      setLoadError("Couldn't load big ideas. Try closing and reopening this subject.");
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectId]);

  const dirty = editing && draft.trim() !== (data?.text ?? "").trim();

  // Tells the parent whenever "dirty" changes, and clears it on unmount —
  // so a parent panel that gated its Close/Escape on this never gets
  // stuck thinking there's an unsaved edit after this editor is gone.
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => {
      if (dirty) onDirtyChange?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  function startEditing() {
    setDraft(data?.text ?? "");
    setSaveError(null);
    setEditing(true);
  }

  function cancelEditing() {
    if (dirty && !window.confirm("Discard your unsaved big ideas edit?")) return;
    setSaveError(null);
    if (autoEdit) {
      onCancelAutoEdit?.();
      return;
    }
    setEditing(false);
  }

  async function save(text: string) {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await setBigIdeas(subjectId, text);
      setData(next);
      setShowHistory(false);
      if (autoEdit) {
        onSaved?.();
      } else {
        setEditing(false);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Couldn't save your big ideas.");
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <div className="content-panel-error">{loadError}</div>;
  if (data === null) return <div className="dashboard-empty">Loading…</div>;

  if (!editing) {
    if (!data.text) {
      return (
        <button type="button" className="btn-link big-ideas-add" onClick={startEditing}>
          + Add big ideas
        </button>
      );
    }
    return (
      <div className={compact ? "big-ideas-view big-ideas-view-compact" : "big-ideas-view"}>
        <p className="big-ideas-text">{data.text}</p>
        <div className="big-ideas-actions">
          <button type="button" className="btn-secondary" onClick={startEditing}>
            Edit
          </button>
          {data.history.length > 0 && (
            <button type="button" className="btn-link" onClick={() => setShowHistory((s) => !s)}>
              {showHistory ? "Hide history" : `History (${data.history.length})`}
            </button>
          )}
        </div>
        {showHistory && (
          <ul className="big-ideas-history">
            {[...data.history].reverse().map((entry, i) => (
              <li key={`${entry.updatedAt}-${i}`}>
                <div className="big-ideas-history-date">{new Date(entry.updatedAt).toLocaleString()}</div>
                <p className="big-ideas-history-text">{entry.text}</p>
                <button type="button" className="btn-secondary" disabled={saving} onClick={() => save(entry.text)}>
                  Restore this version
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="big-ideas-editor">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={compact ? 3 : 5}
        maxLength={MAX_BIG_IDEAS_CHARS}
        disabled={saving}
        placeholder="The handful of ideas that tie this subject together, in your own words."
        autoFocus
      />
      <div className="big-ideas-counter">
        {draft.length}/{MAX_BIG_IDEAS_CHARS}
      </div>
      {saveError && <div className="tune-panel-error">{saveError}</div>}
      <div className="big-ideas-actions">
        <button type="button" className="btn-primary" disabled={saving} onClick={() => save(draft)}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn-secondary" disabled={saving} onClick={cancelEditing}>
          Cancel
        </button>
      </div>
    </div>
  );
}
