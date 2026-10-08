// Formats stored preferences (preferences.js, SPEC.md section 8) into the
// block appended to a question/grading/bank-generation prompt. One place so
// the three callers can't drift on wording or ordering.

export function formatPreferencesBlock(preferences) {
  const texts = (preferences ?? [])
    .map((p) => (typeof p === "string" ? p : p?.text))
    .filter((t) => typeof t === "string" && t.trim());
  if (!texts.length) return "";

  return `\n\nThe user has set these standing study preferences. Follow them unless they conflict with an instruction above:\n${texts
    .map((t) => `- ${t}`)
    .join("\n")}`;
}
