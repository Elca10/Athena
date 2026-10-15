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

test("Done closes without handing anything off when there's nothing unread", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onDone = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([baseItem({ topicsExtractedAt: "2026-01-01T00:00:00.000Z" })]);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} onDone={onDone} />);
  await screen.findByText("lecture1.md");

  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

// The bug: Done used to keep this modal open (blocking the whole app)
// for the minute or two the topic and question turns take. Now it hands
// the reading off to the dashboard and closes at once.
test("Done with unread content hands off and closes straight away, without waiting on any model turn", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onDone = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([baseItem({ topicsExtractedAt: null })]);
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} onDone={onDone} />);
  await screen.findByText("lecture1.md");

  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalled();
  expect(api.scanTopics).not.toHaveBeenCalled();
  expect(api.scanBank).not.toHaveBeenCalled();
});

test("Done saves notes still typed in the box instead of dropping them, then hands them off", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onDone = vi.fn();
  vi.mocked(api.listContent)
    .mockResolvedValueOnce([])
    .mockResolvedValue([baseItem({ originalFilename: "pasted-notes.md", topicsExtractedAt: null })]);
  vi.mocked(api.addPastedNotes).mockResolvedValue(baseItem());
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} onDone={onDone} />);
  await screen.findByText("No content added yet.");

  await user.type(screen.getByPlaceholderText(/Paste class notes/), "Mitosis has four phases.");
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(api.addPastedNotes).toHaveBeenCalledWith("s1", "Mitosis has four phases.");
  expect(onDone).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

test("if typed notes can't be saved, Done keeps the panel open with the error", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onDone = vi.fn();
  vi.mocked(api.listContent).mockResolvedValue([]);
  vi.mocked(api.addPastedNotes).mockRejectedValue(new Error("Athena isn't responding"));
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={onClose} onDone={onDone} />);
  await screen.findByText("No content added yet.");

  await user.type(screen.getByPlaceholderText(/Paste class notes/), "Mitosis has four phases.");
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(await screen.findByText("Athena isn't responding")).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/Paste class notes/)).toHaveValue("Mitosis has four phases.");
  expect(onDone).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
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

test("several files can be picked at once; one bad file doesn't stop the others", async () => {
  const user = userEvent.setup({ applyAccept: false });
  vi.mocked(api.listContent).mockResolvedValue([]);
  vi.mocked(api.uploadTextContent).mockResolvedValue(baseItem());
  render(<AddContentPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);
  await screen.findByText("No content added yet.");

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input.multiple).toBe(true);
  await user.upload(input, [
    new File(["one"], "week1.md", { type: "text/markdown" }),
    new File(["x"], "photo.jpg", { type: "image/jpeg" }),
    new File(["two"], "week2.txt", { type: "text/plain" }),
  ]);

  expect(await screen.findByText(/photo\.jpg: unsupported file type/)).toBeInTheDocument();
  expect(api.uploadTextContent).toHaveBeenCalledWith("s1", "week1.md", "one");
  expect(api.uploadTextContent).toHaveBeenCalledWith("s1", "week2.txt", "two");
});
