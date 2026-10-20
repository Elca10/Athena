// Issue #10: course material goes into a turn's prompt as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitOversized, excerptFor, materialBlock } from "../material.js";

const deck = (n, body = (i) => `text of slide ${i}`) => Array.from({ length: n }, (_, i) => `## Slide ${i + 1}\n${body(i + 1)}`).join("\n\n");

test("splitOversized leaves small files alone and cuts big ones at slide boundaries, keeping the id", () => {
  const small = { id: "s", name: "small.pdf", text: deck(2) };
  const big = { id: "b", name: "big.pptx", text: deck(60, () => "x".repeat(90)) };
  const out = splitOversized([small, big], 2_000);
  assert.equal(out[0], small);
  const parts = out.slice(1);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.id === "b" && p.text.length <= 2_000 && p.sizeBytes === p.text.length));
  assert.ok(parts.every((p) => p.text.startsWith("## Slide")), "every part starts at a slide");
  assert.match(parts[0].name, /^big\.pptx \(part 1 of \d+\)$/);
  assert.equal(parts.map((p) => p.text).join("\n"), big.text, "nothing lost or reordered");
});

test("excerptFor keeps the slides that mention a topic, in order, and falls back to the start", () => {
  const text = deck(100, (i) => (i === 40 ? "Krebs cycle overview" : i === 70 ? "the citric acid (Krebs) cycle yields NADH" : "y".repeat(80)));
  const ex = excerptFor(text, ["Krebs cycle"], 1_000);
  assert.match(ex, /## Slide 40\nKrebs cycle overview/);
  assert.match(ex, /## Slide 70\n/);
  assert.ok(ex.indexOf("Slide 40") < ex.indexOf("Slide 70"));
  assert.ok(ex.length <= 1_000);
  assert.equal(excerptFor(text, ["Photosynthesis"], 500), text.slice(0, 500));
  assert.equal(excerptFor("short", ["x"], 500), "short", "under the limit: whole text");
});

test("materialBlock numbers files and can't be broken by a quote in a filename", () => {
  assert.equal(materialBlock([{ name: 'a "b".pdf', text: " hi \n" }]), `<file number="1" name="a 'b'.pdf">\nhi\n</file>`);
});
