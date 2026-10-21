import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createSubject } from "../../subjects.js";
import { makeBigIdeasRouter } from "../bigIdeas.js";
import { makeTempDir } from "../../testHelpers/tempDir.js";

async function startApp() {
  const dir = await makeTempDir("athena-bigideas-route-");
  const app = express();
  app.use(express.json());
  app.use("/api/subjects/:id/big-ideas", makeBigIdeasRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { dir, base: (id) => `http://127.0.0.1:${port}/api/subjects/${id}/big-ideas`, server };
}

test("GET for an unknown subject returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(base("no-such-id"));
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("GET starts empty for a real subject", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Thermodynamics" });
    const body = await (await fetch(base(subject.id))).json();
    assert.equal(body.text, "");
    assert.deepEqual(body.history, []);
  } finally {
    server.close();
  }
});

test("PUT then GET round-trips the saved text", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Thermodynamics" });
    const putRes = await fetch(base(subject.id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Energy is conserved; entropy increases." }),
    });
    assert.equal(putRes.status, 200);
    const saved = await putRes.json();
    assert.equal(saved.text, "Energy is conserved; entropy increases.");

    const got = await (await fetch(base(subject.id))).json();
    assert.deepEqual(got, saved);
  } finally {
    server.close();
  }
});

test("PUT for an unknown subject returns 404 and saves nothing", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(base("no-such-id"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Anything" }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("PUT with text over the length limit returns 400 and leaves the stored value alone", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Thermodynamics" });
    await fetch(base(subject.id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "kept" }),
    });
    const res = await fetch(base(subject.id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(5000) }),
    });
    assert.equal(res.status, 400);
    const got = await (await fetch(base(subject.id))).json();
    assert.equal(got.text, "kept");
  } finally {
    server.close();
  }
});

test("a second PUT moves the first text into history", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Thermodynamics" });
    await fetch(base(subject.id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Draft one" }),
    });
    const res = await fetch(base(subject.id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Draft two" }),
    });
    const body = await res.json();
    assert.equal(body.text, "Draft two");
    assert.equal(body.history.length, 1);
    assert.equal(body.history[0].text, "Draft one");
  } finally {
    server.close();
  }
});
