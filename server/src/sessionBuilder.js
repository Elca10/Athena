// Session building (SPEC.md section 4's "Study" button; section 6's
// interleaving principle): given one or more subjects, decides which
// topics a new session actually covers. `topics.js`/`scheduler.js` already
// own what "due" means per subject — this module only decides how many of
// each subject's due topics go into one session, and in what order.
//
// Interleaving (section 6: "mix topics ... and subjects ... instead of
// blocking one topic") is a round-robin across the subjects passed in,
// one topic per subject per pass, rather than draining one subject's due
// list before touching the next.

import { listDueTopics, listTopics } from "./topics.js";
import { listContent } from "./content.js";

/** Most topics one session is built with. A session longer than this
 * risks exactly the fatigue/low-quality-answers problem "desirable
 * difficulty" (section 6) warns against. No number is given in the spec —
 * Ada's call, section 11. */
export const MAX_SESSION_TOPICS = 12;

// `contentIds` (issue #6: "not all exams are cumulative") keeps only
// topics found in at least one of those files. Topics whose source is
// unknown can't match. No ids (or an empty list) means every topic.
function fromContent(contentIds) {
  const wanted = Array.isArray(contentIds) && contentIds.length ? new Set(contentIds) : null;
  return (t) => !wanted || (Array.isArray(t.sourceContentIds) && t.sourceContentIds.some((id) => wanted.has(id)));
}

/**
 * Picks due topic ids across one or more subjects, round-robin
 * interleaved, capped at `limit`. A subject with nothing due simply
 * contributes nothing; duplicate subject ids in the input are only
 * queried once. `reviewAhead` (the user chose "Review ahead anyway" after
 * being told nothing is due) takes each subject's topics soonest-due
 * first instead, so studying early still starts with what's closest to
 * being forgotten.
 */
export async function buildSessionTopicIds(
  appDataDir,
  subjectIds,
  { limit = MAX_SESSION_TOPICS, now = new Date(), reviewAhead = false, contentIds = null, preferBanked = false } = {},
) {
  const uniqueSubjectIds = [...new Set(subjectIds)];
  const fromWanted = fromContent(contentIds);
  const queues = [];
  for (const subjectId of uniqueSubjectIds) {
    const picked = (
      reviewAhead
        ? (await listTopics(appDataDir, subjectId)).sort((a, b) => (a.fsrs?.due ?? 0) - (b.fsrs?.due ?? 0))
        : await listDueTopics(appDataDir, subjectId, now)
    ).filter(fromWanted);
    // Ready mode: topics that already have practice questions first
    // (they're written a chunk at a time, issue #10), keeping due order
    // within each group.
    if (preferBanked) picked.sort((a, b) => Number(!a.bankGeneratedAt) - Number(!b.bankGeneratedAt));
    if (picked.length) queues.push(picked.map((t) => t.id));
  }

  const topicIds = [];
  const pointers = queues.map(() => 0);
  let madeProgress = true;
  while (topicIds.length < limit && madeProgress) {
    madeProgress = false;
    for (let i = 0; i < queues.length && topicIds.length < limit; i++) {
      if (pointers[i] < queues[i].length) {
        topicIds.push(queues[i][pointers[i]]);
        pointers[i] += 1;
        madeProgress = true;
      }
    }
  }
  return topicIds;
}

function formatIn(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in about ${days} days`;
}

/**
 * Plain-language reason no session can be built right now, for when
 * `buildSessionTopicIds` came back empty: either there's nothing to study
 * yet, or everything has been reviewed and isn't due again until later.
 * With `contentIds`, only the topics found in those files count.
 */
export async function explainNothingDue(appDataDir, subjectIds, { now = new Date(), contentIds = null } = {}) {
  const topics = [];
  for (const subjectId of new Set(subjectIds)) topics.push(...(await listTopics(appDataDir, subjectId)));
  const chosen = topics.filter(fromContent(contentIds));
  if (topics.length && !chosen.length) {
    return "Athena hasn't found any topics in the files you picked. Pick other files, or study all of this subject's content.";
  }
  if (!topics.length) {
    let unread = 0;
    for (const subjectId of new Set(subjectIds)) {
      // With no topics anywhere, all content counts as unread (issue #5).
      unread += (await listContent(appDataDir, subjectId)).length;
    }
    if (unread) {
      return "Athena hasn't read your content yet. Open Add content on the subject's card and click Done, so it can find the topics to quiz you on.";
    }
    return "There's nothing to study here yet. Add some course content first (Add content on the subject's card).";
  }
  const nextDue = Math.min(...chosen.map((t) => t.fsrs?.due ?? Infinity));
  if (!Number.isFinite(nextDue)) return "Nothing is due right now. Check back later.";
  return `You're all caught up: nothing is due right now. The next topic is due ${formatIn(nextDue - now.getTime())}.`;
}
