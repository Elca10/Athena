import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AddContentPanel } from "./AddContentPanel";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function baseItem(overrides: Partial<api.ContentItem> = {}): api.ContentItem {
  return {
    id: "c1",
    subjectId: "s1",
    originalFilename: "lecture1.md",
    extension: ".md",
    source: "upload",
    sizeBytes: 10,
    addedAt: "2026-01-01T00:00:00.000Z",
    topicsExtractedAt: null,
    unreliablePages: [],
    ...overrides,
  };
}

test("shows the empty state, then lists content once loaded", async () => {
  vi.mocked(api.listContent).mockResolvedValue([]);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);

  expect(await screen.findByText("No content added yet.")).toBeInTheDocument();
  expect(api.listContent).toHaveBeenCalledWith("s1");
});

test("renders existing content items, flagging any with unreliable pages or slides", async () => {
  vi.mocked(api.listContent).mockResolvedValue([
    baseItem({ id: "c1", originalFilename: "clean.md" }),
    baseItem({ id: "c2", originalFilename: "scanned.pdf", extension: ".pdf", unreliablePages: [2, 5] }),
    baseItem({ id: "c3", originalFilename: "deck.pptx", extension: ".pptx", unreliablePages: [3] }),
  ]);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);

  expect(await screen.findByText("clean.md")).toBeInTheDocument();
  expect(screen.getByText("scanned.pdf")).toBeInTheDocument();
  expect(screen.getByText(/unreliable on pages 2, 5/)).toBeInTheDocument();
  expect(screen.getByText("deck.pptx")).toBeInTheDocument();
  expect(screen.getByText(/unreliable on slide 3/)).toBeInTheDocument();
});

test("the file input accepts .pdf and .pptx alongside the plain-text formats", async () => {
  vi.mocked(api.listContent).mockResolvedValue([]);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);
  await screen.findByText("No content added yet.");

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input.accept).toContain(".pdf");
  expect(input.accept).toContain(".pptx");
  expect(input.accept).toContain(".txt");
  expect(input.accept).toContain(".md");
});

test("uploading a .txt file reads it as text and refreshes the list", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listContent).mockResolvedValueOnce([]).mockResolvedValueOnce([baseItem({ originalFilename: "notes.txt", extension: ".txt" })]);
  vi.mocked(api.uploadTextContent).mockResolvedValue(baseItem({ originalFilename: "notes.txt", extension: ".txt" }));
  const onContentAdded = vi.fn();
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} onContentAdded={onContentAdded} />);
  await screen.findByText("No content added yet.");

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["hello world"], "notes.txt", { type: "text/plain" });
  await user.upload(input, file);

  expect(await screen.findByText("notes.txt")).toBeInTheDocument();
  expect(api.uploadTextContent).toHaveBeenCalledWith("s1", "notes.txt", "hello world");
  expect(onContentAdded).toHaveBeenCalled();
});

test("uploading a .pdf file reads it as base64 and uses the binary upload path", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listContent).mockResolvedValueOnce([]).mockResolvedValueOnce([
    baseItem({ originalFilename: "slides.pdf", extension: ".pdf" }),
  ]);
  vi.mocked(api.uploadBinaryContent).mockResolvedValue(baseItem({ originalFilename: "slides.pdf", extension: ".pdf" }));
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);
  await screen.findByText("No content added yet.");

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "slides.pdf", { type: "application/pdf" });
  await user.upload(input, file);

  expect(await screen.findByText("slides.pdf")).toBeInTheDocument();
  expect(api.uploadBinaryContent).toHaveBeenCalledTimes(1);
  const [subjectId, filename, base64] = vi.mocked(api.uploadBinaryContent).mock.calls[0];
  expect(subjectId).toBe("s1");
  expect(filename).toBe("slides.pdf");
  const decodedBytes = Array.from(atob(base64), (c) => c.charCodeAt(0));
  expect(decodedBytes).toEqual([0x25, 0x50, 0x44, 0x46]);
  expect(api.uploadTextContent).not.toHaveBeenCalled();
});

test("uploading a .pptx file reads it as base64 and uses the binary upload path", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listContent).mockResolvedValueOnce([]).mockResolvedValueOnce([
    baseItem({ originalFilename: "deck.pptx", extension: ".pptx" }),
  ]);
  vi.mocked(api.uploadBinaryContent).mockResolvedValue(baseItem({ originalFilename: "deck.pptx", extension: ".pptx" }));
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);
  await screen.findByText("No content added yet.");

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "deck.pptx", {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  await user.upload(input, file);

  expect(await screen.findByText("deck.pptx")).toBeInTheDocument();
  expect(api.uploadBinaryContent).toHaveBeenCalledTimes(1);
  const [subjectId, filename, base64] = vi.mocked(api.uploadBinaryContent).mock.calls[0];
  expect(subjectId).toBe("s1");
  expect(filename).toBe("deck.pptx");
  const decodedBytes = Array.from(atob(base64), (c) => c.charCodeAt(0));
  expect(decodedBytes).toEqual([0x50, 0x4b, 0x03, 0x04]);
  expect(api.uploadTextContent).not.toHaveBeenCalled();
});

test("shows the server's own error message when an upload is rejected", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listContent).mockResolvedValue([]);
  vi.mocked(api.uploadBinaryContent).mockRejectedValue(new Error("No extractable text found in this PDF (it may be a scanned, image-only document)"));
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);
  await screen.findByText("No content added yet.");

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "scanned.pdf", { type: "application/pdf" });
  await user.upload(input, file);

  expect(await screen.findByText(/no extractable text found/i)).toBeInTheDocument();
});

test("rejects an unsupported extension client-side without calling the API", async () => {
  // The input's own `accept` attribute already stops a real OS file
  // dialog from offering a .docx, but drag-and-drop (or "All Files" in
  // the dialog) can still hand the input a file the accept hint doesn't
  // cover — applyAccept:false reproduces that here, to prove the
  // client-side check in handleFile is real defense, not dead code the
  // browser's own filtering happens to make unreachable. (.docx, not
  // .pptx — PPTX is a supported binary format now.)
  const user = userEvent.setup({ applyAccept: false });
  vi.mocked(api.listContent).mockResolvedValue([]);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);
  await screen.findByText("No content added yet.");

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["whatever"], "notes.docx", { type: "application/octet-stream" });
  await user.upload(input, file);

  expect(await screen.findByText(/unsupported file type/i)).toBeInTheDocument();
  expect(api.uploadTextContent).not.toHaveBeenCalled();
  expect(api.uploadBinaryContent).not.toHaveBeenCalled();
});

test("adds pasted notes and refreshes the list", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listContent).mockResolvedValueOnce([]).mockResolvedValueOnce([
    baseItem({ originalFilename: "pasted-notes-x.md", source: "paste" }),
  ]);
  vi.mocked(api.addPastedNotes).mockResolvedValue(baseItem({ originalFilename: "pasted-notes-x.md", source: "paste" }));
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);
  await screen.findByText("No content added yet.");

  await user.type(screen.getByPlaceholderText(/paste class notes/i), "what I learned today");
  await user.click(screen.getByRole("button", { name: "Add notes" }));

  expect(api.addPastedNotes).toHaveBeenCalledWith("s1", "what I learned today");
  expect(await screen.findByText("pasted-notes-x.md")).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/paste class notes/i)).toHaveValue("");
});

test("Add notes is disabled for blank input", async () => {
  vi.mocked(api.listContent).mockResolvedValue([]);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);
  await screen.findByText("No content added yet.");

  expect(screen.getByRole("button", { name: "Add notes" })).toBeDisabled();
});

test("Done closes immediately when there's nothing unscanned, without calling scanTopics", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([]);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} />);
  await screen.findByText("No content added yet.");

  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalled();
  expect(api.scanTopics).not.toHaveBeenCalled();
});

test("Done scans unprocessed content for topics before closing", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onContentAdded = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([baseItem({ topicsExtractedAt: null })]);
  vi.mocked(api.scanTopics).mockResolvedValue({ ok: true, skipped: false, topicsAdded: 3, filesProcessed: 1, errors: [] });
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} onContentAdded={onContentAdded} />);
  await screen.findByText("lecture1.md");

  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(api.scanTopics).toHaveBeenCalledWith("s1");
  expect(onContentAdded).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

test("Done skips the scan when every item already has topics extracted", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([baseItem({ topicsExtractedAt: "2026-01-01T00:00:00.000Z" })]);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} />);
  await screen.findByText("lecture1.md");

  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(api.scanTopics).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

test("shows a scan error inline and keeps the panel open instead of closing", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([baseItem({ topicsExtractedAt: null })]);
  vi.mocked(api.scanTopics).mockResolvedValue({
    ok: false,
    skipped: false,
    topicsAdded: 0,
    filesProcessed: 0,
    errors: ["1 file(s) not processed: the reply was empty"],
  });
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} />);
  await screen.findByText("lecture1.md");

  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(await screen.findByText(/the reply was empty/)).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

test("shows a thrown scanTopics error inline and keeps the panel open", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([baseItem({ topicsExtractedAt: null })]);
  vi.mocked(api.scanTopics).mockRejectedValue(new Error("fetch failed"));
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} />);
  await screen.findByText("lecture1.md");

  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(await screen.findByText("fetch failed")).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

test("after a failed scan, Close (or Escape) leaves without re-running the scan", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([baseItem({ topicsExtractedAt: null })]);
  vi.mocked(api.scanTopics).mockResolvedValue({
    ok: true,
    skipped: false,
    topicsAdded: 0,
    filesProcessed: 0,
    errors: ["1 file(s) not processed: no readable topic list in the reply"],
  });
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} />);
  await screen.findByText("lecture1.md");
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(await screen.findByText(/Looked for topics, but/)).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();

  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(api.scanTopics).toHaveBeenCalledTimes(1);
});

test("Done saves notes still typed in the box instead of dropping them, then reads them", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.mocked(api.listContent)
    .mockResolvedValueOnce([])
    .mockResolvedValue([baseItem({ originalFilename: "pasted-notes.md", topicsExtractedAt: null })]);
  vi.mocked(api.addPastedNotes).mockResolvedValue(baseItem());
  vi.mocked(api.scanTopics).mockResolvedValue({ ok: true, skipped: false, topicsAdded: 2, filesProcessed: 1, errors: [] });
  vi.mocked(api.scanBank).mockResolvedValue({ ok: true, skipped: false, topicsProcessed: 2, questionsAdded: 8, errors: [] });
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} />);
  await screen.findByText("No content added yet.");

  await user.type(screen.getByPlaceholderText(/Paste class notes/), "Mitosis has four phases.");
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(api.addPastedNotes).toHaveBeenCalledWith("s1", "Mitosis has four phases.");
  expect(api.scanTopics).toHaveBeenCalledWith("s1");
  expect(onClose).toHaveBeenCalled();
});

test("Done reads topics, writes practice questions, then reports what it found", async () => {
  const user = userEvent.setup();
  const onFinished = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([baseItem({ topicsExtractedAt: null })]);
  vi.mocked(api.scanTopics).mockResolvedValue({ ok: true, skipped: false, topicsAdded: 3, filesProcessed: 1, errors: [] });
  vi.mocked(api.scanBank).mockResolvedValue({ ok: true, skipped: false, topicsProcessed: 3, questionsAdded: 12, errors: [] });
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} onFinished={onFinished} />);
  await screen.findByText("lecture1.md");
  expect(screen.getByText("Not read yet")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(api.scanBank).toHaveBeenCalledWith("s1");
  expect(onFinished).toHaveBeenCalledWith("Found 3 new topics in Biology. Ready to study.");
});

test("Escape doesn't throw away typed-but-unsaved notes", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([]);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} />);
  await screen.findByText("No content added yet.");
  await user.type(screen.getByPlaceholderText(/Paste class notes/), "half-written notes");
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
});

test("an item can be removed (after confirming)", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(api.listContent).mockResolvedValueOnce([baseItem()]).mockResolvedValue([]);
  vi.mocked(api.removeContent).mockResolvedValue(undefined);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "Remove lecture1.md" }));
  expect(api.removeContent).toHaveBeenCalledWith("s1", "c1");
  expect(await screen.findByText("No content added yet.")).toBeInTheDocument();
});
