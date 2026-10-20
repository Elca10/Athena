// Issue #6: topics remember which content they came from, so a session can
// be limited to chosen files and removing a file removes the topics that
// came only from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addPlannedTopics, listTopics, removeContentFromTopics, inferTopicSources, topicsOnlyFrom } from "../topics.js";
import { addBankQuestions, listBankQuestions } from "../questionBank.js";
import { addPastedNotes, removeContent, backfillTopicSources } from "../content.js";
import { buildSessionTopicIds, explainNothingDue } from "../sessionBuilder.js";
import { buildExtractionPrompt, parseExtractionReply, withSources } from "../topicExtraction.js";
import { createSubject, renameSubject, archiveSubject } from "../subjects.js";
import { createSession, getSession } from "../sessions.js";

async function scratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "athena-provenance-"));
}

const QUESTION = {
  type: "free_recall",
  prompt: "Explain it.",
  difficulty: "intro",
  modelAnswer: "An answer.",
  rubric: ["a point"],
  misconceptions: [],
};

test("a new topic stores its sources; the same topic found in another file adds that file", async () => {
  const dir = await scratchDir();
  await addPlannedTopics(dir, "s1", [{ name: "Osmosis", sourceContentIds: ["c1"] }]);
  const added = await addPlannedTopics(dir, "s1", [{ name: "osmosis ", sourceContentIds: ["c2"] }]);
  assert.equal(added.length, 0, "not a new topic");
  const [topic] = await listTopics(dir, "s1");
  assert.deepEqual(topic.sourceContentIds, ["c1", "c2"]);
});

test("a topic with unknown sources stays unknown when found again", async () => {
  const dir = await scratchDir();
  await addPlannedTopics(dir, "s1", ["Osmosis"]);
  await addPlannedTopics(dir, "s1", [{ name: "Osmosis", sourceContentIds: ["c2"] }]);
  const [topic] = await listTopics(dir, "s1");
  assert.equal(topic.sourceContentIds, null);
});

test("removing a file deletes only the topics that came solely from it", async () => {
  const dir = await scratchDir();
  await addPlannedTopics(dir, "s1", [
    { name: "Only in c1", sourceContentIds: ["c1"] },
    { name: "In c1 and c2", sourceContentIds: ["c1", "c2"] },
    { name: "Only in c2", sourceContentIds: ["c2"] },
    "Unknown source",
  ]);
  assert.deepEqual((await topicsOnlyFrom(dir, "s1", "c1")).map((t) => t.name), ["Only in c1"]);

  const removed = await removeContentFromTopics(dir, "s1", "c1");
  assert.deepEqual(removed.map((t) => t.name), ["Only in c1"]);
  const left = Object.fromEntries((await listTopics(dir, "s1")).map((t) => [t.name, t.sourceContentIds]));
  assert.deepEqual(left, { "In c1 and c2": ["c2"], "Only in c2": ["c2"], "Unknown source": null });
});

test("removeContent takes the topics only that file covered, and their practice questions", async () => {
  const dir = await scratchDir();
  const item = await addPastedNotes(dir, "s1", { text: "Osmosis and diffusion." });
  const other = await addPastedNotes(dir, "s1", { text: "Diffusion again." });
  const [osmosis, diffusion] = await addPlannedTopics(dir, "s1", [
    { name: "Osmosis", sourceContentIds: [item.id] },
    { name: "Diffusion", sourceContentIds: [item.id, other.id] },
  ]);
  await addBankQuestions(dir, osmosis.id, "s1", [QUESTION]);
  await addBankQuestions(dir, diffusion.id, "s1", [QUESTION]);

  const result = await removeContent(dir, "s1", item.id);
  assert.deepEqual(result.removedTopics.map((t) => t.name), ["Osmosis"]);
  assert.deepEqual((await listTopics(dir, "s1")).map((t) => t.name), ["Diffusion"]);
  assert.equal((await listBankQuestions(dir, osmosis.id)).length, 0);
  assert.equal((await listBankQuestions(dir, diffusion.id)).length, 1);
});

test("removing a file takes its topics out of unfinished sessions, so resuming one never hits a missing topic", async () => {
  const dir = await scratchDir();
  const item = await addPastedNotes(dir, "s1", { text: "Osmosis." });
  const other = await addPastedNotes(dir, "s1", { text: "Diffusion." });
  const [osmosis, diffusion] = await addPlannedTopics(dir, "s1", [
    { name: "Osmosis", sourceContentIds: [item.id] },
    { name: "Diffusion", sourceContentIds: [other.id] },
  ]);
  const mixed = await createSession(dir, { subjectIds: ["s1"], mode: "ready", topicIds: [osmosis.id, diffusion.id] });
  const onlyOsmosis = await createSession(dir, { subjectIds: ["s1"], mode: "ready", topicIds: [osmosis.id] });

  await removeContent(dir, "s1", item.id);
  assert.deepEqual((await getSession(dir, mixed.id)).topicIds, [diffusion.id]);
  assert.equal((await getSession(dir, mixed.id)).status, "active");
  const emptied = await getSession(dir, onlyOsmosis.id);
  assert.deepEqual(emptied.topicIds, []);
  assert.equal(emptied.status, "completed", "nothing asked and nothing left to ask: closed, not a dead Resume");
});

test("older topics are linked to files by their name (or all its words), once", async () => {
  const dir = await scratchDir();
  const lecture = await addPastedNotes(dir, "s1", { text: "Today: the Krebs   cycle, and how ATP synthase makes energy." });
  const other = await addPastedNotes(dir, "s1", { text: "Glycolysis happens in the cytoplasm." });
  await addPlannedTopics(dir, "s1", ["Krebs cycle", "ATP synthase energy", "Protein folding", "Glycolysis"]);
  // Simulate topics saved before provenance existed (no field at all).
  const raw = path.join(dir, "db", "topics.json");
  const stored = JSON.parse(await fs.readFile(raw, "utf8")).map(({ sourceContentIds: _s, ...t }) => t);
  await fs.writeFile(raw, JSON.stringify(stored));

  assert.equal(await backfillTopicSources(dir), 4);
  const byName = Object.fromEntries((await listTopics(dir, "s1")).map((t) => [t.name, t]));
  assert.deepEqual(byName["Krebs cycle"].sourceContentIds, [lecture.id]);
  assert.equal(byName["Krebs cycle"].sourcesInferred, true);
  assert.deepEqual(byName["ATP synthase energy"].sourceContentIds, [lecture.id], "every word present");
  assert.deepEqual(byName["Glycolysis"].sourceContentIds, [other.id]);
  assert.equal(byName["Protein folding"].sourceContentIds, null, "no match: unknown");
  assert.equal(await backfillTopicSources(dir), 0, "runs once per topic");
});

test("inferTopicSources leaves topics that already have a source field alone", async () => {
  const dir = await scratchDir();
  await addPlannedTopics(dir, "s1", [{ name: "Osmosis", sourceContentIds: ["c9"] }]);
  const n = await inferTopicSources(dir, { listContentFor: async () => [], readText: async () => null });
  assert.equal(n, 0);
  assert.deepEqual((await listTopics(dir, "s1"))[0].sourceContentIds, ["c9"]);
});

test("a session limited to chosen files only gets topics found in them", async () => {
  const dir = await scratchDir();
  const [a, , c] = await addPlannedTopics(dir, "s1", [
    { name: "From lecture 1", sourceContentIds: ["l1"] },
    { name: "From lecture 2", sourceContentIds: ["l2"] },
    { name: "From both", sourceContentIds: ["l1", "l2"] },
    "Unknown source",
  ]);
  const ids = await buildSessionTopicIds(dir, ["s1"], { contentIds: ["l1"] });
  assert.deepEqual(ids.sort(), [a.id, c.id].sort());
  assert.equal((await buildSessionTopicIds(dir, ["s1"])).length, 4, "no filter: everything due");
});

test("with files chosen, the nothing-due reason is about those files", async () => {
  const dir = await scratchDir();
  await addPlannedTopics(dir, "s1", [{ name: "From lecture 1", sourceContentIds: ["l1"] }, "Unknown source"]);
  assert.match(await explainNothingDue(dir, ["s1"], { contentIds: ["l2"] }), /hasn't found any topics in the files you picked/);
  assert.doesNotMatch(await explainNothingDue(dir, ["s1"], { contentIds: ["l1"] }), /files you picked/);
});

test("the extraction prompt numbers the files, and replies map numbers to content ids", () => {
  const prompt = buildExtractionPrompt({
    subjectName: "Bio",
    files: [{ name: "a.md", text: "A" }, { name: "b.md", text: "B" }],
    existingTopics: ["Osmosis"],
    batchIndex: 0,
    batchCount: 1,
  });
  assert.match(prompt, /<file number="1" name="a\.md">[\s\S]*<file number="2" name="b\.md">/);
  assert.match(prompt, /list it too, using its exact name/);
  assert.match(prompt, /"files": \[/);

  const parsed = parseExtractionReply('```json athena-topics\n{"topics":[{"name":"Krebs cycle","files":[2,"x",9]},{"name":"Osmosis"}],"summary":"s"}\n```');
  assert.deepEqual(parsed.topics.map((t) => t.files), [[2, 9], []]);

  const batch = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(withSources(parsed.topics[0], batch).sourceContentIds, ["b"], "out-of-range 9 ignored");
  assert.deepEqual(withSources(parsed.topics[1], batch).sourceContentIds, ["a", "b"], "none named: whole batch");
  assert.equal("files" in withSources(parsed.topics[0], batch), false);
});

test("a topic listed once per file keeps all its files; an entry with no file numbers means the whole batch", () => {
  const reply = (topics) => "```json athena-topics\n" + JSON.stringify({ topics, summary: "s" }) + "\n```";
  const twice = parseExtractionReply(reply([{ name: "Cell cycle", files: [1] }, { name: "cell cycle", files: [2] }]));
  assert.deepEqual(twice.topics.map((t) => [t.name, t.files]), [["Cell cycle", [1, 2]]]);
  const vague = parseExtractionReply(reply([{ name: "Cell cycle", files: [1] }, { name: "Cell cycle" }]));
  assert.deepEqual(vague.topics[0].files, []);
});

test("renameSubject renames with the same rules as creating one", async () => {
  const dir = await scratchDir();
  const bio = await createSubject(dir, { name: "biology" });
  const chem = await createSubject(dir, { name: "Chemistry" });
  assert.equal((await renameSubject(dir, bio.id, { name: "  Biology   101 " })).name, "Biology 101");
  assert.equal((await renameSubject(dir, bio.id, { name: "BIOLOGY 101" })).name, "BIOLOGY 101", "case-only change is fine");
  await assert.rejects(() => renameSubject(dir, bio.id, { name: "chemistry" }), /already have a subject called "Chemistry"/);
  await archiveSubject(dir, chem.id);
  await assert.rejects(() => renameSubject(dir, bio.id, { name: "Chemistry" }), /archived subject/);
  await assert.rejects(() => renameSubject(dir, bio.id, { name: "   " }), /required/);
  await assert.rejects(() => renameSubject(dir, "nope", { name: "X" }), /not found/);
});
