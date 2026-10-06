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

import { listDueTopics } from "./topics.js";

/** Most topics one session is built with. A session longer than this
 * risks exactly the fatigue/low-quality-answers problem "desirable
 * difficulty" (section 6) warns against. No number is given in the spec —
 * Ada's call, section 11. */
export const MAX_SESSION_TOPICS = 12;

/**
 * Picks due topic ids across one or more subjects, round-robin
 * interleaved, capped at `limit`. A subject with nothing due simply
 * contributes nothing; duplicate subject ids in the input are only
 * queried once.
 */
export async function buildSessionTopicIds(appDataDir, subjectIds, { limit = MAX_SESSION_TOPICS, now = new Date() } = {}) {
  const uniqueSubjectIds = [...new Set(subjectIds)];
  const queues = [];
  for (const subjectId of uniqueSubjectIds) {
    const due = await listDueTopics(appDataDir, subjectId, now);
    if (due.length) queues.push(due.map((t) => t.id));
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
