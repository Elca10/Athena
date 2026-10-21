import { useEffect, useRef, useState } from "react";
import {
  listContent,
  listReflections,
  listTopics,
  removeContent,
  type ContentItem,
  type Reflection,
  type Topic,
} from "./api";
import { classifyTopicMastery, type MasteryLabel } from "./topicMastery";
import { confirmContentRemoval } from "./contentRemoval";
import { ContentFileList } from "./ContentFileList";
import { DeadlinesSection } from "./DeadlinesSection";
import { useEscapeKey } from "../useEscapeKey";
import { useFocusTrap } from "../useFocusTrap";

// Subject detail view (SPEC-v2.md section 4 / SPEC.md section 4: "Clicking
// opens a subject detail view"). Opened the same way as Add content/Tune
// Athena/Report a bug — a focus-trapped `.modal` over a backdrop, Escape
// and a Close button to leave, nothing else on screen able to steal focus
// meanwhile. Three read-mostly sections, each with its own loading/empty/
// error state since each is its own fetch:
//   - Topics with mastery (topics.js's FSRS state, via classifyTopicMastery
//     — mirrors subjectSummary.js's own classifyMastery, so a topic's badge
//     here always agrees with the subject card's new/learning/mastered
//     counts).
//   - Content files, reusing AddContentPanel's own Remove action
//     (ContentFileList + confirmContentRemoval) rather than a second copy
//     of it — there's no content rename anywhere yet, so there's nothing
//     to reuse for that.
//   - Past reflections, read-only (GET /api/subjects/:id/reflections
//     already existed; nothing new to build there).
//   - Deadlines (DeadlinesSection.tsx): add/edit/delete, and whether to
//     study for each. A half-typed deadline makes Close/Escape ask first.
export function SubjectDetailPanel({
  subjectId,
  subjectName,
  onClose,
  onContentChanged,
}: {
  subjectId: string;
  subjectName: string;
  onClose: () => void;
  /** Called after a content file is removed (or a deadline changed) here,
   * so the dashboard's subject card stays in sync. */
  onContentChanged?: () => void;
}) {
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [topicsError, setTopicsError] = useState<string | null>(null);
  const [content, setContent] = useState<ContentItem[] | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentBusy, setContentBusy] = useState(false);
  const [reflections, setReflections] = useState<Reflection[] | null>(null);
  const [reflectionsError, setReflectionsError] = useState<string | null>(null);

  const [deadlineDraft, setDeadlineDraft] = useState(false);
  function requestClose() {
    if (deadlineDraft && !window.confirm("Discard the deadline you were adding? What you typed won't be saved.")) return;
    onClose();
  }

  useEscapeKey(requestClose);
  const dialogRef = useRef<HTMLElement>(null);
  useFocusTrap(dialogRef);

  async function refreshTopics() {
    setTopicsError(null);
    try {
      setTopics(await listTopics(subjectId));
    } catch {
      setTopicsError("Couldn't load topics. Try closing and reopening this subject.");
    }
  }

  async function refreshContent() {
    setContentError(null);
    try {
      setContent(await listContent(subjectId));
    } catch {
      setContentError("Couldn't load content. Try closing and reopening this subject.");
    }
  }

  async function refreshReflections() {
    setReflectionsError(null);
    try {
      setReflections(await listReflections(subjectId));
    } catch {
      setReflectionsError("Couldn't load past reflections. Try closing and reopening this subject.");
    }
  }

  useEffect(() => {
    refreshTopics();
    refreshContent();
    refreshReflections();
  }, [subjectId]);

  async function removeContentItem(item: ContentItem) {
    if (!(await confirmContentRemoval(subjectId, item))) return;
    setContentError(null);
    setContentBusy(true);
    try {
      await removeContent(subjectId, item.id);
      await Promise.all([refreshContent(), refreshTopics()]);
      onContentChanged?.();
    } catch (err) {
      setContentError(err instanceof Error ? err.message : "Couldn't remove that item.");
    } finally {
      setContentBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="subject-detail-panel modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="subject-detail-title"
      >
        <div className="content-panel-header">
          <h2 id="subject-detail-title">{subjectName}</h2>
          <button type="button" onClick={requestClose}>
            Close
          </button>
        </div>

        <section className="subject-detail-section" aria-labelledby="subject-detail-topics">
          <h3 id="subject-detail-topics">Topics</h3>
          {topicsError && <div className="content-panel-error">{topicsError}</div>}
          {!topicsError && topics === null && <div className="dashboard-empty">Loading…</div>}
          {!topicsError && topics !== null && topics.length === 0 && (
            <div className="dashboard-empty">
              No topics yet. Add content from the dashboard, then click Done — Athena reads it for topics.
            </div>
          )}
          {!topicsError && topics !== null && topics.length > 0 && (
            <ul className="subject-detail-topic-list">
              {topics.map((topic) => (
                <li key={topic.id}>
                  <span>{topic.name}</span>
                  <span className={`topic-mastery topic-mastery-${classifyTopicMastery(topic)}`}>
                    {masteryLabel(classifyTopicMastery(topic))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <DeadlinesSection subjectId={subjectId} topics={topics} onChanged={onContentChanged} onDirtyChange={setDeadlineDraft} />

        <section className="subject-detail-section" aria-labelledby="subject-detail-content">
          <h3 id="subject-detail-content">Content</h3>
          {contentError && <div className="content-panel-error">{contentError}</div>}
          {!contentError && content === null && <div className="dashboard-empty">Loading…</div>}
          {!contentError && content !== null && (
            <ContentFileList items={content} busy={contentBusy} onRemove={removeContentItem} />
          )}
        </section>

        <section className="subject-detail-section" aria-labelledby="subject-detail-reflections">
          <h3 id="subject-detail-reflections">Past reflections</h3>
          {reflectionsError && <div className="content-panel-error">{reflectionsError}</div>}
          {!reflectionsError && reflections === null && <div className="dashboard-empty">Loading…</div>}
          {!reflectionsError && reflections !== null && reflections.length === 0 && (
            <div className="dashboard-empty">No reflections yet — they're prompted at the end of a study session.</div>
          )}
          {!reflectionsError && reflections !== null && reflections.length > 0 && (
            <ul className="subject-detail-reflection-list">
              {[...reflections].reverse().map((reflection) => (
                <li key={reflection.id}>
                  <div className="subject-detail-reflection-date">
                    {new Date(reflection.createdAt).toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </div>
                  <ReflectionField label="What did you learn?" value={reflection.learned} />
                  <ReflectionField label="What surprised you?" value={reflection.surprised} />
                  <ReflectionField label="What connects to what?" value={reflection.connects} />
                  <ReflectionField label="What will you do differently?" value={reflection.differently} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </section>
    </div>
  );
}

function masteryLabel(label: MasteryLabel): string {
  if (label === "mastered") return "Mastered";
  if (label === "learning") return "Learning";
  return "New";
}

function ReflectionField({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <p className="subject-detail-reflection-field">
      <strong>{label}</strong> {value}
    </p>
  );
}
