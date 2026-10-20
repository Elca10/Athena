import { afterEach, expect, test, vi } from "vitest";
import { readNewContent } from "./readNewContent";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function item(topicsExtractedAt: string | null): api.ContentItem {
  return {
    id: "c1",
    subjectId: "s1",
    originalFilename: "lecture1.md",
    extension: ".md",
    source: "upload",
    sizeBytes: 10,
    addedAt: "2026-01-01T00:00:00.000Z",
    topicsExtractedAt,
    unreliablePages: [],
  };
}

const TOPICS_OK = { ok: true, skipped: false, topicsAdded: 3, filesProcessed: 1, errors: [] };
const BANK_OK = { ok: true, skipped: false, topicsProcessed: 3, questionsAdded: 12, errors: [] };

test("does nothing (and says nothing) when there's no unread content", async () => {
  vi.mocked(api.listContent).mockResolvedValue([item("2026-01-01T00:00:00.000Z")]);
  expect(await readNewContent("s1", "Biology")).toEqual({ ok: true, message: "" });
  expect(api.scanTopics).not.toHaveBeenCalled();
});

test("reads topics, then writes practice questions, reporting each stage and the result", async () => {
  vi.mocked(api.listContent).mockResolvedValue([item(null)]);
  vi.mocked(api.scanTopics).mockResolvedValue(TOPICS_OK);
  vi.mocked(api.scanBank).mockResolvedValue(BANK_OK);
  const stages: string[] = [];

  const outcome = await readNewContent("s1", "Biology", (s) => stages.push(s));

  expect(stages).toEqual(["topics", "questions"]);
  expect(api.scanTopics).toHaveBeenCalledWith("s1");
  expect(api.scanBank).toHaveBeenCalledWith("s1");
  expect(outcome).toEqual({ ok: true, message: "Found 3 new topics in Biology. Ready to study." });
});

test("says so when the content had no new topics", async () => {
  vi.mocked(api.listContent).mockResolvedValue([item(null), item(null)]);
  vi.mocked(api.scanTopics).mockResolvedValue({ ...TOPICS_OK, topicsAdded: 0 });
  vi.mocked(api.scanBank).mockResolvedValue(BANK_OK);
  expect((await readNewContent("s1", "Biology")).message).toBe("Read 2 new items for Biology, but found no new topics.");
});

test("a topic-reading error skips question writing and tells the user how to retry", async () => {
  vi.mocked(api.listContent).mockResolvedValue([item(null)]);
  vi.mocked(api.scanTopics).mockResolvedValue({ ...TOPICS_OK, ok: false, topicsAdded: 0, errors: ["the reply was empty \n"] });

  const outcome = await readNewContent("s1", "Biology");

  expect(outcome.ok).toBe(false);
  expect(outcome.message).toMatch(/but: the reply was empty\. Open Add content/);
  expect(outcome.message).toMatch(/Open Add content and click Done to try again/);
  expect(api.scanBank).not.toHaveBeenCalled();
});

test("a thrown error (e.g. Athena restarting) comes back as a message, never an exception", async () => {
  vi.mocked(api.listContent).mockResolvedValue([item(null)]);
  vi.mocked(api.scanTopics).mockRejectedValue(new Error("fetch failed"));

  const outcome = await readNewContent("s1", "Biology");

  expect(outcome.ok).toBe(false);
  expect(outcome.message).toMatch(/fetch failed/);
});

test("question-writing trouble still reports the topics found, plus a note", async () => {
  vi.mocked(api.listContent).mockResolvedValue([item(null)]);
  vi.mocked(api.scanTopics).mockResolvedValue(TOPICS_OK);
  vi.mocked(api.scanBank).mockRejectedValue(new Error("boom"));

  const outcome = await readNewContent("s1", "Biology");

  expect(outcome.ok).toBe(true);
  expect(outcome.message).toMatch(/^Found 3 new topics in Biology\. Ready to study\. Practice questions couldn't be written yet/);
});

test("when more topics are waiting for questions, Done says they're written as you study (issue #10)", async () => {
  vi.mocked(api.listContent).mockResolvedValue([{ topicsExtractedAt: null } as api.ContentItem]);
  vi.mocked(api.scanTopics).mockResolvedValue({ ok: true, skipped: false, topicsAdded: 30, filesProcessed: 1, errors: [] } as Awaited<ReturnType<typeof api.scanTopics>>);
  vi.mocked(api.scanBank).mockResolvedValue({ ok: true, skipped: false, topicsProcessed: 12, questionsAdded: 48, remaining: 18, errors: [] });
  const out = await readNewContent("s1", "Biology");
  expect(out.message).toMatch(/Found 30 new topics in Biology\. Ready to study\. Practice questions are ready for your next session; Athena writes more after each one\./);
});
