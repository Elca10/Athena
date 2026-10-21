import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { SubjectDetailPanel } from "./SubjectDetailPanel";
import { DeadlinesSection } from "./DeadlinesSection";
import { localToday } from "./calendarDates";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function topic(id: string, name: string): api.Topic {
  return { id, subjectId: "s1", name, notes: "", createdAt: "2026-01-01", fsrs: { state: 0 }, bankGeneratedAt: null };
}

function deadline(overrides: Partial<api.Deadline> = {}): api.Deadline {
  return {
    id: "d1",
    subjectId: "s1",
    title: "Midterm",
    date: "2099-11-02",
    topicIds: [],
    studying: true,
    source: "manual",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

const TOPICS = [topic("t1", "Cells"), topic("t2", "Genetics")];

function mockPanel(deadlines: api.Deadline[] = []) {
  vi.mocked(api.listTopics).mockResolvedValue(TOPICS);
  vi.mocked(api.listContent).mockResolvedValue([]);
  vi.mocked(api.listReflections).mockResolvedValue([]);
  vi.mocked(api.listDeadlines).mockResolvedValue(deadlines);
}

test("empty state says what deadlines are for, and Add deadline creates one covering some topics", async () => {
  const user = userEvent.setup();
  mockPanel();
  const onChanged = vi.fn();
  render(<SubjectDetailPanel subjectId="s1" subjectName="Biology" onClose={() => {}} onContentChanged={onChanged} />);
  expect(await screen.findByText(/No deadlines yet/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Add deadline" }));
  const form = screen.getByRole("form", { name: "New deadline" });
  const save = within(form).getByRole("button", { name: "Add deadline" });
  expect(save).toBeDisabled();
  await user.type(within(form).getByLabelText("Title"), "Midterm");
  await user.type(within(form).getByLabelText("Date"), "2099-11-02");
  await user.click(within(form).getByLabelText("Only some topics"));
  expect(within(form).getByText(/Pick at least one topic/)).toBeInTheDocument();
  expect(save).toBeDisabled();
  await user.click(within(form).getByLabelText("Genetics"));

  vi.mocked(api.createDeadline).mockResolvedValue(deadline({ topicIds: ["t2"] }));
  vi.mocked(api.listDeadlines).mockResolvedValue([deadline({ topicIds: ["t2"] })]);
  await user.click(save);
  expect(api.createDeadline).toHaveBeenCalledWith("s1", { title: "Midterm", date: "2099-11-02", topicIds: ["t2"] });
  expect(await screen.findByText("Covers Genetics")).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "New deadline" })).not.toBeInTheDocument();
  expect(onChanged).toHaveBeenCalled();
});

test("a refused deadline keeps the form and what was typed, with the server's reason", async () => {
  const user = userEvent.setup();
  render(<DeadlinesSection subjectId="s1" topics={TOPICS} />);
  vi.mocked(api.listDeadlines).mockResolvedValue([]);
  await user.click(await screen.findByRole("button", { name: "Add deadline" }));
  await user.type(screen.getByLabelText("Title"), "Quiz");
  await user.type(screen.getByLabelText("Date"), "2099-11-02");
  vi.mocked(api.createDeadline).mockRejectedValue(new Error("A subject can have at most 100 deadlines."));
  await user.click(screen.getByRole("button", { name: "Add deadline" }));
  expect(await screen.findByText(/at most 100 deadlines/)).toBeInTheDocument();
  expect(screen.getByLabelText("Title")).toHaveValue("Quiz");
});

test("closing the subject with a half-typed deadline asks first; declining keeps it", async () => {
  const user = userEvent.setup();
  mockPanel();
  const onClose = vi.fn();
  render(<SubjectDetailPanel subjectId="s1" subjectName="Biology" onClose={onClose} />);
  await user.click(await screen.findByRole("button", { name: "Add deadline" }));
  await user.type(screen.getByLabelText("Title"), "Final");

  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(confirm).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Title")).toHaveValue("Final");

  // Escape inside the form only ever cancels the form (after asking), never the panel.
  await user.click(screen.getByLabelText("Title"));
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await user.keyboard("{Escape}");
  expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();

  confirm.mockClear();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(confirm).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

test("an untouched form closes with the panel without asking", async () => {
  const user = userEvent.setup();
  mockPanel();
  const onClose = vi.fn();
  const confirm = vi.spyOn(window, "confirm");
  render(<SubjectDetailPanel subjectId="s1" subjectName="Biology" onClose={onClose} />);
  await user.click(await screen.findByRole("button", { name: "Add deadline" }));
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(confirm).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

test("lists deadlines with dates and coverage; toggles studying, edits and deletes (after confirming)", async () => {
  const user = userEvent.setup();
  const onChanged = vi.fn();
  vi.mocked(api.listDeadlines).mockResolvedValue([
    deadline(),
    deadline({ id: "d2", title: "Lab report", date: "2099-12-01", topicIds: ["gone"], studying: false }),
  ]);
  render(<DeadlinesSection subjectId="s1" topics={TOPICS} onChanged={onChanged} />);
  const midterm = (await screen.findByText("Midterm")).closest("li") as HTMLElement;
  expect(within(midterm).getByText("Covers all topics")).toBeInTheDocument();
  const lab = screen.getByText("Lab report").closest("li") as HTMLElement;
  expect(within(lab).getByText(/topics were removed/)).toBeInTheDocument();
  expect(within(lab).getByLabelText("Study for this")).not.toBeChecked();

  vi.mocked(api.updateDeadline).mockResolvedValue(deadline({ studying: false }));
  await user.click(within(midterm).getByLabelText("Study for this"));
  expect(api.updateDeadline).toHaveBeenCalledWith("s1", "d1", { studying: false });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

  await user.click(within(midterm).getByRole("button", { name: "Edit" }));
  const form = screen.getByRole("form", { name: "Edit Midterm" });
  expect(within(form).getByLabelText("Title")).toHaveValue("Midterm");
  await user.clear(within(form).getByLabelText("Title"));
  await user.type(within(form).getByLabelText("Title"), "Midterm 1");
  await user.click(within(form).getByRole("button", { name: "Save changes" }));
  expect(api.updateDeadline).toHaveBeenLastCalledWith("s1", "d1", { title: "Midterm 1", date: "2099-11-02", topicIds: [] });

  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(within(midterm).getByRole("button", { name: "Delete" }));
  expect(confirm.mock.calls[0][0]).toMatch(/Study blocks you've moved or marked done stay/);
  expect(api.deleteDeadline).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await user.click(within(midterm).getByRole("button", { name: "Delete" }));
  expect(api.deleteDeadline).toHaveBeenCalledWith("s1", "d1");
});

test("a failed toggle says so; a failed load offers Try again", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listDeadlines).mockRejectedValueOnce(new Error("down")).mockResolvedValue([deadline()]);
  render(<DeadlinesSection subjectId="s1" topics={TOPICS} />);
  expect(await screen.findByText("Couldn't load deadlines.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  const item = (await screen.findByText("Midterm")).closest("li") as HTMLElement;
  vi.mocked(api.updateDeadline).mockRejectedValue(new Error("Couldn't save that deadline (500)."));
  await user.click(within(item).getByLabelText("Study for this"));
  expect(await screen.findByText(/Couldn't save that deadline/)).toBeInTheDocument();
});

test("a past deadline is marked passed and can't be studied for", async () => {
  vi.mocked(api.listDeadlines).mockResolvedValue([deadline({ date: "2000-01-01" })]);
  render(<DeadlinesSection subjectId="s1" topics={TOPICS} />);
  const item = (await screen.findByText("Midterm")).closest("li") as HTMLElement;
  expect(within(item).getByText(/passed/)).toBeInTheDocument();
  expect(within(item).getByLabelText("Study for this")).toBeDisabled();
  expect(localToday() > "2000-01-01").toBe(true);
});
