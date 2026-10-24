// Per-subject summary stats for the dashboard's subject cards (SPEC.md
// section 4: "mastery summary (new/learning/mastered counts), due-today
// count, next deadline, Ready question bank size"). Pure aggregation over
// topics.js/questionBank.js's existing data — no storage of its own.
// "Next deadline" is the soonest deadline (deadlines.js) on or after the
// user's local today, whether or not they're studying for it.

import { listTopics, listDueTopics } from "./topics.js";
import { listContent } from "./content.js";
import { listBankQuestions } from "./questionBank.js";
import { listDeadlines, nextDeadline } from "./deadlines.js";
import { localDateOf } from "./localDate.js";

// ts-fsrs's State enum: New=0, Learning=1, Review=2, Relearning=3. "Review"
// is the only state meaning a topic has graduated past its initial learning
// steps, so it's the natural "mastered" bucket for a v1 summary (an implementer's
// call, section 11-style — a deeper mastery model, if ever wanted, is a bigger
// feature than a dashboard card stat).
export function classifyMastery(topic) {
  const state = topic.fsrs?.state;
  if (state === 2) return "mastered";
  if (state === 1 || state === 3) return "learning";
  return "new";
}

export function computeMasteryCounts(topics) {
  const counts = { new: 0, learning: 0, mastered: 0 };
  for (const topic of topics) counts[classifyMastery(topic)] += 1;
  return counts;
}

/**
 * Whether reviewing a topic just moved it into "mastered" (above) that it
 * wasn't in before — SPEC-v2.md section 5's milestone-applause rule
 * ("applaud progress when real milestones are reached ... stated as the
 * earned fact"): the one milestone this app can detect deterministically,
 * from the FSRS state change alone, with no model call and no guessing.
 * Pure, exported for its own test; liveSession.js's `submitLiveAnswer` and
 * readySession.js's answer/self-grade paths all call this with the
 * topic's state right before and right after `recordTopicReview`.
 */
export function justReachedMastered(beforeTopic, afterTopic) {
  return classifyMastery(beforeTopic) !== "mastered" && classifyMastery(afterTopic) === "mastered";
}

export async function getSubjectSummary(appDataDir, subjectId, now = new Date()) {
  const topics = await listTopics(appDataDir, subjectId);
  const dueCount = (await listDueTopics(appDataDir, subjectId, now)).length;
  const bankCounts = await Promise.all(topics.map((t) => listBankQuestions(appDataDir, t.id)));
  const bankSize = bankCounts.reduce((sum, questions) => sum + questions.length, 0);
  // Content counts let the dashboard say what to do next: add content, or
  // finish reading what was added (Close instead of Done leaves it unread).
  const content = await listContent(appDataDir, subjectId);
  // No topics at all means nothing was read successfully, whatever the
  // flags say (issue #5), and the next Done reads it all again.
  const unreadContentCount = topics.length ? content.filter((item) => !item.topicsExtractedAt).length : content.length;
  return {
    masteryCounts: computeMasteryCounts(topics),
    dueCount,
    bankSize,
    topicCount: topics.length,
    contentCount: content.length,
    unreadContentCount,
    nextDeadline: pickNextDeadline(await listDeadlines(appDataDir, subjectId), now),
  };
}

function pickNextDeadline(deadlines, now) {
  const next = nextDeadline(deadlines, localDateOf(now));
  return next ? { id: next.id, title: next.title, date: next.date, studying: next.studying } : null;
}
