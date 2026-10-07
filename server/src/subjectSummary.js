// Per-subject summary stats for the dashboard's subject cards (SPEC.md
// section 4: "mastery summary (new/learning/mastered counts), due-today
// count, next deadline, Ready question bank size"). Pure aggregation over
// topics.js/questionBank.js's existing data — no storage of its own.
// "Next deadline" is deliberately not included yet: subject deadlines
// (section 9) aren't a build step yet, so there's no data to aggregate.

import { listTopics, listDueTopics } from "./topics.js";
import { listBankQuestions } from "./questionBank.js";

// ts-fsrs's State enum: New=0, Learning=1, Review=2, Relearning=3. "Review"
// is the only state meaning a topic has graduated past its initial learning
// steps, so it's the natural "mastered" bucket for a v1 summary (Ada's call,
// section 11-style — a deeper mastery model, if ever wanted, is a bigger
// feature than a dashboard card stat).
function classifyMastery(topic) {
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

export async function getSubjectSummary(appDataDir, subjectId, now = new Date()) {
  const topics = await listTopics(appDataDir, subjectId);
  const dueCount = (await listDueTopics(appDataDir, subjectId, now)).length;
  const bankCounts = await Promise.all(topics.map((t) => listBankQuestions(appDataDir, t.id)));
  const bankSize = bankCounts.reduce((sum, questions) => sum + questions.length, 0);
  return { masteryCounts: computeMasteryCounts(topics), dueCount, bankSize };
}
