import type { ContentItem } from "./api";
import { formatUnreliableNote } from "./contentRemoval";

/** The read/not-read list of a subject's content items, with a Remove
 * action — shared by AddContentPanel (under its upload drop zone) and
 * SubjectDetailPanel (the detail view's own content section, which has
 * no upload — "Add content" on the subject card is still where that
 * happens). Callers own loading state; this only renders the list once
 * it has items (an empty list still renders the "no content" message so
 * both callers get it for free). */
export function ContentFileList({
  items,
  busy,
  onRemove,
}: {
  items: ContentItem[];
  busy: boolean;
  onRemove: (item: ContentItem) => void;
}) {
  if (items.length === 0) return <div className="dashboard-empty">No content added yet.</div>;
  return (
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
                  onClick={() => onRemove(item)}
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
  );
}
