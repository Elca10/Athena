import { useEffect, useRef, useState } from "react";
import { addPreference, deletePreference, getSettings, listPreferences, updateSettings, type Preference, type Settings } from "./api";
import { useEscapeKey } from "../useEscapeKey";
import { useFocusTrap } from "../useFocusTrap";

// Tune Athena (SPEC.md section 8): plain-language study preferences the
// user writes, stored verbatim and later included in Athena's prompts
// (server/src/preferencesPrompt.js). Add/delete are synchronous REST
// calls that complete before responding, with no background model turn in
// flight, so there is no draft recovery or pending-turn reconciliation.
//
// Also holds the one app setting that exists so far (server/src/settings.js):
// whether a study session's reflection is followed by a short "revise your
// big ideas?" prompt (SPEC-v2.md section 3's structure-building row). Off
// by default; this checkbox is the only place to turn it on — turning it
// off never deletes anything already written, and a subject's big ideas
// stay editable from its own detail view either way.
export function TuneAthenaPanel({ onClose }: { onClose: () => void }) {
  const [preferences, setPreferences] = useState<Preference[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  useEscapeKey(onClose);
  const dialogRef = useRef<HTMLElement>(null);
  useFocusTrap(dialogRef);

  async function refresh() {
    setPreferences(await listPreferences());
  }

  useEffect(() => {
    refresh();
    (async () => {
      try {
        setSettingsState((await getSettings()) ?? null);
      } catch {
        setSettingsError("Couldn't load this setting. Try closing and reopening Tune Athena.");
      }
    })();
  }, []);

  async function toggleBigIdeasPrompt(checked: boolean) {
    setSettingsError(null);
    const previous = settings;
    setSettingsState((s) => (s ? { ...s, bigIdeasPromptEnabled: checked } : s));
    try {
      setSettingsState(await updateSettings({ bigIdeasPromptEnabled: checked }));
    } catch (err) {
      setSettingsState(previous ?? null);
      setSettingsError(err instanceof Error ? err.message : "Couldn't save that setting.");
    }
  }

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
    <div className="modal-backdrop">
      <section className="tune-panel modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="tune-panel-title">
        <div className="tune-panel-header">
          <h2 id="tune-panel-title">Tune Athena</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="tune-panel-hint">
          Plain-language preferences ("harder questions on proofs", "always give me a worked example after a miss"),
          included in Athena's prompts. They never edit the shared persona, code, or repo.
        </p>
        <section className="tune-panel-setting">
          <label>
            <input
              type="checkbox"
              checked={settings?.bigIdeasPromptEnabled ?? false}
              disabled={settings === null}
              onChange={(e) => toggleBigIdeasPrompt(e.target.checked)}
            />
            Prompt me to revise my big ideas after a study session
          </label>
          <p className="tune-panel-hint">
            A subject's big ideas are a short summary you write yourself, in your own words — Athena never writes or
            rewrites it. Off by default; you can always add or edit one from a subject's own page either way.
          </p>
          {settingsError && <div className="tune-panel-error">{settingsError}</div>}
        </section>
        {preferences === null && <div className="dashboard-empty">Loading…</div>}
        {preferences?.length === 0 && <div className="dashboard-empty">No preferences yet.</div>}
        {preferences !== null && preferences.length > 0 && (
          <ul className="tune-panel-list">
            {preferences.map((p) => (
              <li key={p.id}>
                <span>{p.text}</span>
                <button type="button" className="btn-danger" onClick={() => remove(p.id)}>
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
          <button type="submit" className="btn-primary" disabled={!text.trim()}>
            Add
          </button>
        </form>
        {error && <div className="tune-panel-error">{error}</div>}
      </section>
    </div>
  );
}
