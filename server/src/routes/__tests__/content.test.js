import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import PDFDocument from "pdfkit";
import { createSubject } from "../../subjects.js";
import { makeContentRouter } from "../content.js";

/** Real PDF binary, generated fresh (never committed) — same technique as
 * content.test.js/pdfExtract.test.js. */
async function samplePdfBuffer(pages) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-content-route-pdf-"));
  const filePath = path.join(dir, "sample.pdf");
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = createWriteStream(filePath);
    doc.pipe(stream);
    for (const pageText of pages) {
      doc.addPage();
      doc.fontSize(12).text(pageText);
    }
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return fs.readFile(filePath);
}

async function startApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-content-route-"));
  const app = express();
  app.use(express.json());
  app.use("/api/subjects/:id/content", makeContentRouter(dir));
  const server = app.listen(0);
  const { port } = server.address();
  return { dir, base: (id) => `http://127.0.0.1:${port}/api/subjects/${id}/content`, server };
}

test("GET /:id/content for an unknown subject returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(base("no-such-id"));
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST /:id/content for an unknown subject returns 404 and stores nothing", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(base("no-such-id"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "a.txt", text: "hi" }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("POST then GET round-trips an uploaded content record over real HTTP", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Discrete Math" });

    assert.deepEqual(await (await fetch(base(subject.id))).json(), []);

    const createRes = await fetch(base(subject.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "Lecture 1.md", text: "# Lecture 1\n\nContent." }),
    });
    assert.equal(createRes.status, 201);
    const record = await createRes.json();
    assert.equal(record.originalFilename, "Lecture 1.md");
    assert.equal(record.source, "upload");

    assert.deepEqual(await (await fetch(base(subject.id))).json(), [record]);
  } finally {
    server.close();
  }
});

test("POST /:id/content with an unsupported extension returns 400 and creates nothing", async () => {
  // .docx, not .pptx -- PPTX is a supported binary format now.
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const res = await fetch(base(subject.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "notes.docx", text: "whatever" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /unsupported file type/i);
    assert.deepEqual(await (await fetch(base(subject.id))).json(), []);
  } finally {
    server.close();
  }
});

test("POST /:id/content with blank text returns 400", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "History" });
    const res = await fetch(base(subject.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "notes.txt", text: "   " }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /content is empty/i);
  } finally {
    server.close();
  }
});

test("POST /:id/content/notes creates a pasted-notes record with a generated .md filename", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Biology" });
    const res = await fetch(`${base(subject.id)}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "what I learned today" }),
    });
    assert.equal(res.status, 201);
    const record = await res.json();
    assert.equal(record.source, "paste");
    assert.match(record.originalFilename, /^pasted-notes-.+\.md$/);
    assert.deepEqual(await (await fetch(base(subject.id))).json(), [record]);
  } finally {
    server.close();
  }
});

test("POST /:id/content with a real PDF (base64) extracts text and flags unreliable pages over real HTTP", async () => {
  const { dir, base, server } = await startApp();
  try {
    const subject = await createSubject(dir, { name: "Discrete Math" });
    const brokenPage = Array.from({ length: 60 }, (_, i) => `(cid:${i})`).join(" ");
    const rawBytes = await samplePdfBuffer([
      "The quick brown fox jumps over the lazy dog and the cat too.",
      brokenPage,
    ]);

    const createRes = await fetch(base(subject.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "Lecture 1.pdf", contentBase64: rawBytes.toString("base64") }),
    });
    assert.equal(createRes.status, 201);
    const record = await createRes.json();
    assert.equal(record.extension, ".pdf");
    assert.deepEqual(record.unreliablePages, [2]);
    assert.equal(record.sizeBytes, rawBytes.length);

    assert.deepEqual(await (await fetch(base(subject.id))).json(), [record]);
  } finally {
    server.close();
  }
});

test("POST /:id/content/notes for an unknown subject returns 404", async () => {
  const { base, server } = await startApp();
  try {
    const res = await fetch(`${base("no-such-id")}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
