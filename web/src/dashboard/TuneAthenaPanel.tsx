import { useEffect, useState } from "react";
import { addPreference, deletePreference, listPreferences, type Preference } from "./api";

// Tune Athena (SPEC.md section 8): plain-language study preferences the
// user writes, stored verbatim and later included in Athena's prompts
// (server/src/preferencesPrompt.js). Unlike Hub's AgentUpdateInput.tsx —
// the "agent update" panel this one is renamed from — add/delete here are
// synchronous REST calls that complete before responding, with no
// background model turn in flight; none of that panel's draft-recovery or
// pending-turn reconciliation applies.
export function TuneAthenaPanel({ onClose }: { onClose: () => void }) {
  const [preferences, setPreferences] = useState<Preference[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setPreferences(await listPreferences());
  }

  useEffect(() => {
    refresh();
  }, []);

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await addPreference(trimmed);
      setText("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that preference.");
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await deletePreference(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that preference.");
    }
  }

  return (
    <section className="tune-panel">
      <div className="tune-panel-header">
        <h2>Tune Athena</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="tune-panel-hint">
        Plain-language preferences ("harder questions on proofs", "always give me a worked example after a miss"),
        included in Athena's prompts. They never edit the shared persona, code, or repo.
      </p>
      {preferences === null && <div className="dashboard-empty">Loading…</div>}
      {preferences?.length === 0 && <div className="dashboard-empty">No preferences yet.</div>}
      {preferences !== null && preferences.length > 0 && (
        <ul className="tune-panel-list">
          {preferences.map((p) => (
            <li key={p.id}>
              <span>{p.text}</span>
              <button type="button" onClick={() => remove(p.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="tune-panel-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='e.g. "harder questions on proofs"'
        />
        <button type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>
      {error && <div className="tune-panel-error">{error}</div>}
    </section>
  );
}
