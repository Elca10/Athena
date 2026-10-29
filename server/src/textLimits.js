// Length caps for model-written text a user reads (issue #19: "lots of
// reading will scare away users"). The prompts ask for short replies;
// this is the safety net when a reply ignores that. It cuts at the last
// sentence end that fits, so what's shown never stops mid-sentence, and
// only falls back to a word boundary plus "…" when no sentence fits.

/** `text` trimmed to at most `maxChars`, ending on a whole sentence where
 * possible. Pure. */
export function trimToSentences(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const ends = [...head.matchAll(/[.!?](?=\s|$)/g)];
  const lastEnd = ends.length ? ends[ends.length - 1].index + 1 : -1;
  // A sentence end very early would throw away most of the reply: only
  // use it if it keeps at least half of the allowed length.
  if (lastEnd >= maxChars / 2) return head.slice(0, lastEnd);
  const lastSpace = head.lastIndexOf(" ", maxChars - 1);
  return `${head.slice(0, lastSpace > 0 ? lastSpace : maxChars - 1).trimEnd()}…`;
}
