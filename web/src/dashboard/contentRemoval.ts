import { getRemovalPreview, type ContentItem } from "./api";

// Shared by AddContentPanel and SubjectDetailPanel (the two places a
// content item can be removed from) so the confirm text/behavior can't
// drift between them — issue #6's rule (topics found only in a removed
// file go with it) only needs to be gotten right once.

/** Shows the removal confirm dialog, naming any topics that came only
 * from this item so removing it doesn't silently take them with it.
 * Returns whether the user confirmed; doesn't remove anything itself. */
export async function confirmContentRemoval(subjectId: string, item: ContentItem): Promise<boolean> {
  let onlyHere: string[] = [];
  if (item.topicsExtractedAt) {
    try {
      onlyHere = (await getRemovalPreview(subjectId, item.id)).topics;
    } catch {
      // No preview: the confirm just won't list them.
    }
  }
  const extra = onlyHere.length
    ? `\n\nThese topics came only from it and will be removed too, with their practice questions:\n${onlyHere.map((t) => `• ${t}`).join("\n")}`
    : item.topicsExtractedAt
      ? "\n\nIts topics also appear in other content, so they'll stay."
      : "";
  return window.confirm(`Remove "${item.originalFilename}"?${extra}`);
}

// `unreliablePages` holds 1-based page numbers for a PDF, slide numbers
// for a PPTX (same field name for both — see content.js's record
// comment); word it to match so a PPTX's note doesn't say "page".
export function formatUnreliableNote(item: ContentItem): string | null {
  if (!item.unreliablePages.length) return null;
  const unit = item.extension === ".pptx" ? "slide" : "page";
  const label = item.unreliablePages.length === 1 ? unit : `${unit}s`;
  return `⚠️ extraction looked unreliable on ${label} ${item.unreliablePages.join(", ")} — check the source file`;
}
