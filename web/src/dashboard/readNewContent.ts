import { listContent, scanBank, scanTopics } from "./api";

export type ReadStage = "topics" | "questions";
export type ReadOutcome = { ok: boolean; message: string };

// What "Done" in Add content kicks off: read the subject's unread content
// for topics, then write practice questions for them so a Ready session
// works straight away. Runs on the dashboard, not inside the panel, so the
// panel can close the moment Done is clicked and the user isn't stuck
// watching a modal for the minute or two the model turns take. Never
// throws: every outcome comes back as a one-line message for the
// dashboard's notice.
export async function readNewContent(
  subjectId: string,
  subjectName: string,
  onStage: (stage: ReadStage) => void = () => {},
): Promise<ReadOutcome> {
  try {
    const unread = (await listContent(subjectId)).filter((item) => !item.topicsExtractedAt).length;
    if (!unread) return { ok: true, message: "" };
    onStage("topics");
    const topics = await scanTopics(subjectId);
    if (topics.errors.length) {
      return {
        ok: false,
        message: `Looked for topics in ${subjectName}, but: ${topics.errors.join("; ").trim().replace(/[.\s]+$/, "")}. Open Add content and click Done to try again.`,
      };
    }
    onStage("questions");
    let questionsNote = "";
    try {
      const bank = await scanBank(subjectId);
      if (bank.errors.length) questionsNote = " Some practice questions couldn't be written yet; Athena will offer to try again when you study.";
    } catch {
      questionsNote = " Practice questions couldn't be written yet; Athena will offer to try again when you study.";
    }
    const found =
      topics.topicsAdded === 0
        ? `Read ${unread} new item${unread === 1 ? "" : "s"} for ${subjectName}, but found no new topics.`
        : `Found ${topics.topicsAdded} new topic${topics.topicsAdded === 1 ? "" : "s"} in ${subjectName}. Ready to study.`;
    return { ok: true, message: found + questionsNote };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "something went wrong";
    return {
      ok: false,
      message: `Couldn't read the new content for ${subjectName} (${reason}). Open Add content and click Done to try again.`,
    };
  }
}
