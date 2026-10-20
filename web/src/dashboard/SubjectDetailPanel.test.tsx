import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { SubjectDetailPanel } from "./SubjectDetailPanel";
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

function baseTopic(overrides: Partial<api.Topic> = {}): api.Topic {
  return {
    id: "t1",
    subjectId: "s1",
    name: "Osmosis",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    fsrs: { state: 0 },
    bankGeneratedAt: null,
    ...overrides,
  };
}

function baseReflection(overrides: Partial<api.Reflection> = {}): api.Reflection {
  return {
    id: "r1",
    sessionId: "sess1",
    subjectIds: ["s1"],
    learned: "Osmosis moves water, not solute.",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockEmpty() {
  vi.mocked(api.listTopics).mockResolvedValue([]);
  vi.mocked(api.listContent).mockResolvedValue([]);
  vi.mocked(api.listReflections).mockResolvedValue([]);
}

test("shows the empty state for every section when a subject has nothing yet", async () => {
  mockEmpty();
  render(<SubjectDetailPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);

  expect(await screen.findByRole("heading", { name: "Biology" })).toBeInTheDocument();
  expect(await screen.findByText(/No topics yet/)).toBeInTheDocument();
  expect(screen.getByText("No content added yet.")).toBeInTheDocument();
  expect(screen.getByText(/No reflections yet/)).toBeInTheDocument();
});

test("lists topics with their mastery badge", async () => {
  vi.mocked(api.listTopics).mockResolvedValue([
    baseTopic({ id: "t1", name: "Osmosis", fsrs: { state: 0 } }),
    baseTopic({ id: "t2", name: "Mitosis", fsrs: { state: 1 } }),
    baseTopic({ id: "t3", name: "DNA replication", fsrs: { state: 2 } }),
  ]);
  vi.mocked(api.listContent).mockResolvedValue([]);
  vi.mocked(api.listReflections).mockResolvedValue([]);
  render(<SubjectDetailPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);

  const osmosis = (await screen.findByText("Osmosis")).closest("li") as HTMLElement;
  expect(within(osmosis).getByText("New")).toBeInTheDocument();
  const mitosis = screen.getByText("Mitosis").closest("li") as HTMLElement;
  expect(within(mitosis).getByText("Learning")).toBeInTheDocument();
  const dna = screen.getByText("DNA replication").closest("li") as HTMLElement;
  expect(within(dna).getByText("Mastered")).toBeInTheDocument();
});

test("lists content files and can remove one (after confirming)", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(api.listTopics).mockResolvedValue([]);
  vi.mocked(api.listContent).mockResolvedValueOnce([baseItem()]).mockResolvedValue([]);
  vi.mocked(api.listReflections).mockResolvedValue([]);
  vi.mocked(api.removeContent).mockResolvedValue(undefined);
  const onContentChanged = vi.fn();
  render(
    <SubjectDetailPanel subjectId="s1" subjectName="Biology" onClose={() => {}} onContentChanged={onContentChanged} />,
  );

  await user.click(await screen.findByRole("button", { name: "Remove lecture1.md" }));

  expect(api.removeContent).toHaveBeenCalledWith("s1", "c1");
  expect(await screen.findByText("No content added yet.")).toBeInTheDocument();
  expect(onContentChanged).toHaveBeenCalled();
});

test("removing a content file is cancelled if the confirm is declined", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(false);
  vi.mocked(api.listTopics).mockResolvedValue([]);
  vi.mocked(api.listContent).mockResolvedValue([baseItem()]);
  vi.mocked(api.listReflections).mockResolvedValue([]);
  render(<SubjectDetailPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);

  await user.click(await screen.findByRole("button", { name: "Remove lecture1.md" }));

  expect(api.removeContent).not.toHaveBeenCalled();
  expect(screen.getByText("lecture1.md")).toBeInTheDocument();
});

test("lists past reflections, newest first, skipping blank fields", async () => {
  mockEmpty();
  vi.mocked(api.listReflections).mockResolvedValue([
    baseReflection({
      id: "r1",
      createdAt: "2026-01-01T00:00:00.000Z",
      learned: "First reflection",
      surprised: "Osmosis is passive, no energy needed.",
    }),
    baseReflection({ id: "r2", createdAt: "2026-01-05T00:00:00.000Z", learned: "Second reflection", surprised: "" }),
  ]);
  render(<SubjectDetailPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);

  const items = await screen.findAllByRole("listitem");
  const reflectionItems = items.filter((li) => li.textContent?.includes("reflection"));
  expect(reflectionItems[0]).toHaveTextContent("Second reflection");
  expect(reflectionItems[1]).toHaveTextContent("First reflection");
  // r1's surprised field is filled in and shows; r2's is blank and is skipped entirely.
  expect(within(reflectionItems[1]).getByText(/What surprised you\?/)).toBeInTheDocument();
  expect(within(reflectionItems[0]).queryByText(/What surprised you\?/)).not.toBeInTheDocument();
});

test("shows a retryable error instead of hanging on a failed fetch, per section", async () => {
  vi.mocked(api.listTopics).mockRejectedValue(new Error("network error"));
  vi.mocked(api.listContent).mockResolvedValue([]);
  vi.mocked(api.listReflections).mockResolvedValue([]);
  render(<SubjectDetailPanel subjectId="s1" subjectName="Biology" onClose={() => {}} />);

  expect(await screen.findByText(/Couldn't load topics/)).toBeInTheDocument();
  expect(screen.getByText("No content added yet.")).toBeInTheDocument();
});

test("Escape and Close both call onClose", async () => {
  const user = userEvent.setup();
  mockEmpty();
  const onClose = vi.fn();
  render(<SubjectDetailPanel subjectId="s1" subjectName="Biology" onClose={onClose} />);
  await screen.findByRole("heading", { name: "Biology" });

  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);

  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(2);
});
