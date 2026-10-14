import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createSubject } from "../../subjects.js";
import { createSession, endSession, setCurrentQuestion, promptReflection } from "../../sessions.js";
import { addPlannedTopics, recordTopicReview } from "../../topics.js";
import { addBankQuestions } from "../../questionBank.js";
import { makeSessionsRouter } from "../sessions.js";

async function startApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-sessions-route-"));
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", makeSessionsRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { dir, base: `http://127.0.0.1:${port}/api/sessions`, server };
}

test("GET /api/sessions starts empty", async () => {
  const { base, server } = await startApp();
  try {
    assert.deepEqual(await (await fetch(base)).json(), []);
  } finally {
    server.close();
  }
});

test("POST /api/sessions creates a session for a real subject", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Chemistry" });
    await addPlannedTopics(dir, subject.id, ["Bonding"]);
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "live" }),
    });
    assert.equal(res.status, 201);
    const session = await res.json();
    assert.deepEqual(session.subjectIds, [subject.id]);
    // Stored as "active", but nothing is running for it, so the API
    // presents it as resumable "waiting" (routes/sessions.js presentStatus).
    assert.equal(session.status, "waiting");
    assert.deepEqual(await (await fetch(base)).json(), [session]);
  } finally {
    server.close();
  }
});

test("POST /api/sessions refuses (no empty session) when the subject has no topics yet", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Empty" });
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "ready" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /nothing to study here yet.*Add some course content/i);
    assert.deepEqual(await (await fetch(base)).json(), [], "no session may be left behind");
  } finally {
    server.close();
  }
});

test("POST /api/sessions refuses, saying when the next topic is due, when nothing is due now", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Reviewed" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["Osmosis"]);
    await recordTopicReview(dir, topic.id, "easy");
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "ready" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /all caught up.*next topic is due in/i);
  } finally {
    server.close();
  }
});

test("POST /api/sessions auto-builds topicIds from the subject's due topics when none are given", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Biology" });
    const added = await addPlannedTopics(dir, subject.id, ["Mitosis", "Meiosis"]);
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "live" }),
    });
    assert.equal(res.status, 201);
    const session = await res.json();
    assert.deepEqual(session.topicIds.sort(), added.map((t) => t.id).sort());
  } finally {
    server.close();
  }
});

test("POST /api/sessions keeps an explicitly-given topicIds instead of auto-building", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Geology" });
    await addPlannedTopics(dir, subject.id, ["Plate tectonics", "Rock cycle"]);
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "live", topicIds: ["explicit-topic"] }),
    });
    assert.equal(res.status, 201);
    const session = await res.json();
    assert.deepEqual(session.topicIds, ["explicit-topic"]);
  } finally {
    server.close();
  }
});

test("POST /api/sessions with an unknown subject id returns 400", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: ["no-such-subject"], mode: "live" }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await (await fetch(base)).json(), []);
  } finally {
    server.close();
  }
});

test("POST /api/sessions with an unknown mode returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Physics" });
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "turbo" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("GET /api/sessions/:id for an unknown id returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("GET /api/sessions/:id finds a real session", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "ready" });
    const res = await fetch(`${base}/${session.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ...session, status: "waiting" });
  } finally {
    server.close();
  }
});

test("an 'active' session with no turn running is listed as resumable 'waiting' (not stuck as Working…)", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live", topicIds: ["t1"] });
    assert.equal(session.status, "active", "sanity: stored as active");
    const [listed] = await (await fetch(base)).json();
    assert.equal(listed.status, "waiting");
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/status moves between active and waiting", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
    const res = await fetch(`${base}/${session.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "waiting" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "waiting");
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/status with an invalid status returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
    const res = await fetch(`${base}/${session.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/status for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "waiting" }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/status refuses to reopen a completed session (400)", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
    await endSession(dir, session.id);
    const res = await fetch(`${base}/${session.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/end marks a session completed", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
    const res = await fetch(`${base}/${session.id}/end`, { method: "POST" });
    assert.equal(res.status, 200);
    const ended = await res.json();
    assert.equal(ended.status, "completed");
    assert.equal(typeof ended.endedAt, "string");
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/end for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/end`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/archive then /restore round-trips", async () => {
  const { dir, base, server } = await startApp();
  try {
    const session = await createSession(dir, { subjectIds: ["subject-1"], mode: "live" });
    const archiveRes = await fetch(`${base}/${session.id}/archive`, { method: "POST" });
    assert.equal(archiveRes.status, 200);
    assert.equal((await archiveRes.json()).archived, true);
    assert.deepEqual(await (await fetch(base)).json(), []);

    const restoreRes = await fetch(`${base}/${session.id}/restore`, { method: "POST" });
    assert.equal(restoreRes.status, 200);
    assert.equal((await restoreRes.json()).archived, false);
    const list = await (await fetch(base)).json();
    assert.equal(list.length, 1);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/archive for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/archive`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

// generateFirstLiveQuestion's happy path always shells out to the real
// `claude` CLI (no DI seam threaded through the router — same scope
// decision routes/topics.js's own /scan route test made for
// scanSubjectForTopics), so only its validation-error paths are covered
// here; the orchestration itself (with an injected runTurn) is covered in
// liveSession.test.js.

test("POST /api/sessions/:id/live/question for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/live/question`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/live/question on a ready-mode session returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["The French Revolution"]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
    const res = await fetch(`${base}/${session.id}/live/question`, { method: "POST" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /only applies to live-mode sessions/);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/live/question on a live session with no topics returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "live" });
    const res = await fetch(`${base}/${session.id}/live/question`, { method: "POST" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no topics to ask about/);
  } finally {
    server.close();
  }
});

// submitLiveAnswer's happy path also always shells out to the real
// `claude` CLI — same scope decision as /live/question above, so only
// its validation-error paths are covered here; the orchestration itself
// (with an injected runTurn) is covered in liveSession.test.js.

test("POST /api/sessions/:id/live/answer for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/live/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answerText: "x", confidence: 3 }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/live/answer on a ready-mode session returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["The French Revolution"]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
    const res = await fetch(`${base}/${session.id}/live/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answerText: "x", confidence: 3 }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /only applies to live-mode sessions/);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/live/answer on a live session with no current question returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["The French Revolution"]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "live", topicIds: [topic.id] });
    const res = await fetch(`${base}/${session.id}/live/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answerText: "x", confidence: 3 }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no current question to answer/);
  } finally {
    server.close();
  }
});

// Ready mode never shells out to a model (SPEC.md section 5's
// near-zero-model goal), so unlike Live's routes above, the full happy
// path is covered here over real HTTP, not just validation errors.

test("POST /api/sessions/:id/ready/question scrubs answer-key fields from the response", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Algorithms" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["Sorting"]);
    await addBankQuestions(dir, topic.id, subject.id, [
      {
        type: "multiple_choice",
        prompt: "Which is a stable sort?",
        difficulty: "medium",
        modelAnswer: "Merge sort",
        rubric: [],
        misconceptions: [],
        choices: ["Quicksort", "Merge sort"],
        correctIndex: 1,
      },
    ]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });

    const res = await fetch(`${base}/${session.id}/ready/question`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    const served = body.session.currentQuestion;
    assert.equal(served.prompt, "Which is a stable sort?");
    assert.deepEqual(served.choices, ["Quicksort", "Merge sort"]);
    assert.equal(served.correctIndex, undefined);
    assert.equal(served.modelAnswer, undefined);
    assert.equal(served.rubric, undefined);
  } finally {
    server.close();
  }
});

test("GET /api/sessions and GET /api/sessions/:id scrub a waiting Ready session's unanswered question too", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Algorithms" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["Sorting"]);
    await addBankQuestions(dir, topic.id, subject.id, [
      {
        type: "multiple_choice",
        prompt: "Which is a stable sort?",
        difficulty: "medium",
        modelAnswer: "Merge sort",
        rubric: [],
        misconceptions: [],
        choices: ["Quicksort", "Merge sort"],
        correctIndex: 1,
      },
    ]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
    await fetch(`${base}/${session.id}/ready/question`, { method: "POST" });

    for (const url of [base, `${base}/${session.id}`]) {
      const res = await fetch(url);
      const body = await res.json();
      const found = Array.isArray(body) ? body.find((s) => s.id === session.id) : body;
      assert.equal(found.currentQuestion.prompt, "Which is a stable sort?");
      assert.equal(found.currentQuestion.modelAnswer, undefined);
      assert.equal(found.currentQuestion.rubric, undefined);
      assert.equal(found.currentQuestion.correctIndex, undefined);
    }
  } finally {
    server.close();
  }
});

test("GET /api/sessions/:id keeps modelAnswer/rubric once a self-graded question has a pending answer, for resuming", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Algorithms" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["Recursion"]);
    await addBankQuestions(dir, topic.id, subject.id, [
      { type: "short_answer", prompt: "Explain recursion.", difficulty: "medium", modelAnswer: "Calls itself.", rubric: ["mentions base case"], misconceptions: [] },
    ]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
    await fetch(`${base}/${session.id}/ready/question`, { method: "POST" });
    await fetch(`${base}/${session.id}/ready/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answerText: "it calls itself", confidence: 3 }),
    });

    const res = await fetch(`${base}/${session.id}`);
    const body = await res.json();
    assert.equal(body.currentQuestion.modelAnswer, "Calls itself.");
    assert.deepEqual(body.currentQuestion.rubric, ["mentions base case"]);
    assert.equal(body.currentQuestion.pendingAnswer.answerText, "it calls itself");
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/ready/question reports an empty bank as ok:false, not an error", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Algorithms" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["Sorting"]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });

    const res = await fetch(`${base}/${session.id}/ready/question`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.noBank, true);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/ready/question for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/ready/question`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/ready/question on a live-mode session returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["The French Revolution"]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "live", topicIds: [topic.id] });
    const res = await fetch(`${base}/${session.id}/ready/question`, { method: "POST" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /only applies to ready-mode sessions/);
  } finally {
    server.close();
  }
});

test("full Ready round trip over HTTP: multiple_choice answer finalizes in one call", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Algorithms" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["Sorting"]);
    await addBankQuestions(dir, topic.id, subject.id, [
      { type: "multiple_choice", prompt: "p", difficulty: "medium", modelAnswer: "b", rubric: [], misconceptions: [], choices: ["a", "b"], correctIndex: 1 },
    ]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
    await fetch(`${base}/${session.id}/ready/question`, { method: "POST" });

    const res = await fetch(`${base}/${session.id}/ready/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedIndex: 1, confidence: 4 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.finalized, true);
    assert.equal(body.isCorrect, true);
    assert.equal(body.session.status, "waiting"); // between questions: resumable
  } finally {
    server.close();
  }
});

test("full Ready round trip over HTTP: self-graded answer needs /self-grade to finalize", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Algorithms" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["Recursion"]);
    await addBankQuestions(dir, topic.id, subject.id, [
      { type: "short_answer", prompt: "Explain recursion.", difficulty: "medium", modelAnswer: "Calls itself.", rubric: ["mentions base case", "mentions self-call"], misconceptions: [] },
    ]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "ready", topicIds: [topic.id] });
    await fetch(`${base}/${session.id}/ready/question`, { method: "POST" });

    const answerRes = await fetch(`${base}/${session.id}/ready/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answerText: "it calls itself", confidence: 3 }),
    });
    assert.equal(answerRes.status, 200);
    const answerBody = await answerRes.json();
    assert.equal(answerBody.finalized, false);
    assert.equal(answerBody.modelAnswer, "Calls itself.");
    assert.equal(answerBody.session.status, "waiting");

    const selfGradeRes = await fetch(`${base}/${session.id}/ready/self-grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selfGrades: [{ status: "got_it" }, { status: "partly" }] }),
    });
    assert.equal(selfGradeRes.status, 200);
    const selfGradeBody = await selfGradeRes.json();
    assert.equal(selfGradeBody.ok, true);
    assert.equal(selfGradeBody.session.status, "waiting"); // between questions: resumable
    assert.equal(selfGradeBody.session.history[0].rating, "hard");
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/ready/answer for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/ready/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answerText: "x", confidence: 3 }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/ready/self-grade for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/ready/self-grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selfGrades: [] }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/live/answer with a missing confidence returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const [topic] = await addPlannedTopics(dir, subject.id, ["The French Revolution"]);
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "live", topicIds: [topic.id] });
    await setCurrentQuestion(dir, session.id, { topicId: topic.id, subjectId: subject.id, prompt: "x", type: "free_recall", difficulty: "intro" });
    const res = await fetch(`${base}/${session.id}/live/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answerText: "x" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /confidence must be an integer from 1 to 5/);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/reflection stores a reflection and finalizes the session", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "live" });
    await promptReflection(dir, session.id);

    const res = await fetch(`${base}/${session.id}/reflection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learned: "The Revolution had multiple phases", connects: "", surprised: "", differently: "" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reflection.learned, "The Revolution had multiple phases");
    assert.deepEqual(body.reflection.subjectIds, [subject.id]);
    assert.equal(body.session.status, "completed");
    assert.equal(body.session.reflectionPending, false);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/reflection with every field blank returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "live" });
    await promptReflection(dir, session.id);

    const res = await fetch(`${base}/${session.id}/reflection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /at least one reflection answer is required/i);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/reflection on a session not awaiting one returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "live" });
    const res = await fetch(`${base}/${session.id}/reflection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learned: "X" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not awaiting a reflection/);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/reflection for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/reflection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learned: "X" }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/reflection/skip finalizes the session without storing a reflection", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const session = await createSession(dir, { subjectIds: [subject.id], mode: "live" });
    await promptReflection(dir, session.id);

    const res = await fetch(`${base}/${session.id}/reflection/skip`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "completed");
    assert.equal(body.reflectionPending, false);
  } finally {
    server.close();
  }
});

test("POST /api/sessions/:id/reflection/skip for an unknown session returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base}/no-such-id/reflection/skip`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
