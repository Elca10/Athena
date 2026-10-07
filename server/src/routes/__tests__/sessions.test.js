import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createSubject } from "../../subjects.js";
import { createSession, endSession, setCurrentQuestion } from "../../sessions.js";
import { addPlannedTopics } from "../../topics.js";
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
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectIds: [subject.id], mode: "live" }),
    });
    assert.equal(res.status, 201);
    const session = await res.json();
    assert.deepEqual(session.subjectIds, [subject.id]);
    assert.equal(session.status, "active");
    assert.deepEqual(await (await fetch(base)).json(), [session]);
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
    assert.deepEqual(await res.json(), session);
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
    assert.equal(body.session.status, "active");
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
    assert.equal(selfGradeBody.session.status, "active");
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
