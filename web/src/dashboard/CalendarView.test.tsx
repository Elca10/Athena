import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { CalendarView } from "./CalendarView";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function block(overrides: Partial<api.ScheduleBlock> = {}): api.ScheduleBlock {
  return {
    id: "2026-10-20:t1",
    topicId: "t1",
    topicName: "Osmosis",
    subjectId: "s1",
    subjectName: "Biology",
    date: "2026-10-20",
    status: "planned",
    doneBy: null,
    moved: false,
    byYou: false,
    reason: "due",
    deadline: null,
    ...overrides,
  };
}

const DATES = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"];

function schedule(byDate: Record<string, api.ScheduleBlock[]> = {}, extra: Partial<api.Schedule> = {}): api.Schedule {
  const availability = extra.availability ?? { weekdays: [1, 2, 3, 4, 5, 6], minutesPerDay: 30 };
  return {
    today: "2026-10-20",
    horizonDays: DATES.length,
    availability,
    minutesPerBlock: 5,
    blocksPerDay: 6,
    days: DATES.map((date, i) => ({
      date,
      weekday: (2 + i) % 7,
      available: availability.weekdays.includes((2 + i) % 7),
      blocks: byDate[date] ?? [],
      deadlines: date === "2026-10-26" ? [{ id: "d1", title: "Midterm", subjectId: "s1", subjectName: "Biology", studying: true }] : [],
    })),
    unscheduled: [],
    ...extra,
  };
}

function dayCard(heading: RegExp) {
  return screen.getByRole("heading", { name: heading }).closest("li") as HTMLElement;
}

test("shows two weeks of days: today's blocks, deadlines, days off, and why a block is there", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getSchedule).mockResolvedValue(
    schedule({
      "2026-10-20": [block(), block({ id: "2026-10-20:t9", topicId: "t9", topicName: "Mitosis", status: "done", doneBy: "session", reason: "studied" })],
      "2026-10-24": [
        block({
          id: "2026-10-24:t2",
          topicId: "t2",
          topicName: "Genetics",
          date: "2026-10-24",
          reason: "deadline",
          deadline: { id: "d1", title: "Midterm", date: "2026-10-26" },
        }),
      ],
    }),
  );
  render(<CalendarView onBack={() => {}} />);
  expect(screen.getByText("Loading your schedule…")).toBeInTheDocument();
  const today = await waitFor(() => dayCard(/^Today ·/));
  // Two Biology topics today: one collapsed row until opened (issue #22).
  expect(within(today).queryByText("Osmosis")).not.toBeInTheDocument();
  const group = within(today).getByRole("button", { name: /Biology\s*2 topics · 1 done/ });
  expect(group).toHaveAttribute("aria-expanded", "false");
  await user.click(group);
  expect(within(today).getByText("Osmosis")).toBeInTheDocument();
  expect(within(today).getByText("done in a study session")).toBeInTheDocument();
  expect(within(today).getByText("about 5 min to go")).toBeInTheDocument();
  expect(screen.getByText(/before Midterm on/)).toBeInTheDocument();
  expect(screen.getByText("Midterm", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByText("Day off")).toBeInTheDocument();
  // A session-done block can't be "un-done" or moved, only deleted.
  const mitosis = within(today).getByText("Mitosis").closest("li") as HTMLElement;
  expect(within(mitosis).queryByRole("button", { name: /not done/ })).not.toBeInTheDocument();
  expect(within(mitosis).queryByRole("button", { name: /^Move/ })).not.toBeInTheDocument();
  expect(within(mitosis).getByRole("button", { name: /Delete/ })).toBeEnabled();
});

test("Done, Not done and Delete (with Undo) send the decision and show the schedule that comes back", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getSchedule).mockResolvedValue(schedule({ "2026-10-20": [block()] }));
  render(<CalendarView onBack={() => {}} />);
  await screen.findByText("Osmosis");

  vi.mocked(api.scheduleBlockAction).mockResolvedValueOnce({
    ok: true,
    schedule: schedule({ "2026-10-20": [block({ status: "done", doneBy: "you", byYou: true })] }),
  });
  await user.click(screen.getByRole("button", { name: "Mark Osmosis (Biology) done" }));
  expect(api.scheduleBlockAction).toHaveBeenLastCalledWith("2026-10-20:t1", "done", undefined);
  expect(await screen.findByText("marked done")).toBeInTheDocument();

  vi.mocked(api.scheduleBlockAction).mockResolvedValueOnce({ ok: true, schedule: schedule({ "2026-10-20": [block()] }) });
  await user.click(screen.getByRole("button", { name: "Mark Osmosis (Biology) not done" }));
  expect(api.scheduleBlockAction).toHaveBeenLastCalledWith("2026-10-20:t1", "undone", undefined);
  expect(await screen.findByRole("button", { name: "Mark Osmosis (Biology) done" })).toBeInTheDocument();

  vi.mocked(api.scheduleBlockAction).mockResolvedValueOnce({ ok: true, schedule: schedule() });
  await user.click(screen.getByRole("button", { name: "Delete Osmosis (Biology)" }));
  expect(await screen.findByText(/Removed Osmosis from/)).toBeInTheDocument();
  expect(screen.queryByText("Osmosis")).not.toBeInTheDocument();

  vi.mocked(api.scheduleBlockAction).mockResolvedValueOnce({ ok: true, schedule: schedule({ "2026-10-20": [block()] }) });
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(api.scheduleBlockAction).toHaveBeenLastCalledWith("2026-10-20:t1", "restore");
  expect(await screen.findByText("Osmosis")).toBeInTheDocument();
});

test("Move picks a day (days off are labelled), and Cancel leaves the block where it was", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getSchedule).mockResolvedValue(schedule({ "2026-10-20": [block()] }));
  render(<CalendarView onBack={() => {}} />);
  await screen.findByText("Osmosis");

  await user.click(screen.getByRole("button", { name: "Move Osmosis (Biology)" }));
  const select = screen.getByRole("combobox", { name: "Move Osmosis (Biology) to" });
  expect(within(select).getByRole("option", { name: /day off/ })).toBeInTheDocument();
  const moveButton = screen.getByRole("button", { name: "Move" });
  expect(moveButton).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.scheduleBlockAction).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox", { name: /to$/ })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Move Osmosis (Biology)" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Move Osmosis (Biology) to" }), "2026-10-22");
  vi.mocked(api.scheduleBlockAction).mockResolvedValueOnce({
    ok: true,
    schedule: schedule({ "2026-10-22": [block({ date: "2026-10-22", moved: true, byYou: true, reason: "you" })] }),
  });
  await user.click(screen.getByRole("button", { name: "Move" }));
  expect(api.scheduleBlockAction).toHaveBeenCalledWith("2026-10-20:t1", "move", "2026-10-22");
  expect(await screen.findByText("moved by you")).toBeInTheDocument();
  expect(screen.getByText(/Moved Osmosis to/)).toBeInTheDocument();
});

test("a block that changed meanwhile: the reason is shown and the current schedule replaces the stale one", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getSchedule).mockResolvedValue(schedule({ "2026-10-20": [block()] }));
  render(<CalendarView onBack={() => {}} />);
  await screen.findByText("Osmosis");
  vi.mocked(api.scheduleBlockAction).mockResolvedValueOnce({
    ok: false,
    error: "That study block isn't on your schedule any more. The schedule has been refreshed.",
    schedule: schedule(),
  });
  await user.click(screen.getByRole("button", { name: "Mark Osmosis (Biology) done" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/isn't on your schedule any more/);
  expect(screen.queryByText("Osmosis")).not.toBeInTheDocument();
});

test("study days: save the new days, or leaving with unsaved changes asks first", async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  vi.mocked(api.getSchedule).mockResolvedValue(schedule());
  render(<CalendarView onBack={onBack} />);
  const save = await screen.findByRole("button", { name: "Save study days" });
  expect(save).toBeDisabled();
  expect(screen.getByLabelText("Sunday")).not.toBeChecked();

  await user.click(screen.getByLabelText("Saturday"));
  await user.selectOptions(screen.getByLabelText("Minutes per study day"), "45");
  expect(save).toBeEnabled();

  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
  expect(confirm).toHaveBeenCalledWith("Leave without saving your study days?");
  expect(onBack).not.toHaveBeenCalled();

  vi.mocked(api.saveAvailability).mockResolvedValue(schedule({}, { availability: { weekdays: [1, 2, 3, 4, 5], minutesPerDay: 45 } }));
  await user.click(save);
  expect(api.saveAvailability).toHaveBeenCalledWith({ weekdays: [1, 2, 3, 4, 5], minutesPerDay: 45 });
  expect(await screen.findByText(/Saved. The plan now uses your new study days/)).toBeInTheDocument();

  confirm.mockClear();
  await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
  expect(confirm).not.toHaveBeenCalled();
  expect(onBack).toHaveBeenCalled();
});

test("Undo changes puts the study days back; a refused save shows why", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getSchedule).mockResolvedValue(schedule());
  render(<CalendarView onBack={() => {}} />);
  await user.click(await screen.findByLabelText("Monday"));
  await user.click(screen.getByRole("button", { name: "Undo changes" }));
  expect(screen.getByLabelText("Monday")).toBeChecked();
  expect(screen.getByRole("button", { name: "Save study days" })).toBeDisabled();

  await user.click(screen.getByLabelText("Monday"));
  vi.mocked(api.saveAvailability).mockRejectedValue(new Error("Minutes per day must be a whole number from 5 to 600."));
  await user.click(screen.getByRole("button", { name: "Save study days" }));
  expect(await screen.findByText(/Minutes per day must be/)).toBeInTheDocument();
  expect(screen.getByLabelText("Monday")).not.toBeChecked();
});

test("deadlines that don't fit are called out with what to do; no study days says so", async () => {
  vi.mocked(api.getSchedule).mockResolvedValue(
    schedule(
      {},
      {
        availability: { weekdays: [], minutesPerDay: 30 },
        unscheduled: [{ deadlineId: "d1", title: "Midterm", date: "2026-10-26", subjectId: "s1", subjectName: "Biology", topicCount: 4 }],
      },
    ),
  );
  render(<CalendarView onBack={() => {}} />);
  expect(await screen.findByText(/4 topics for Midterm \(Biology, .*\) don't fit before the date/)).toBeInTheDocument();
  expect(screen.getByText(/You haven't picked any study days/)).toBeInTheDocument();
});

test("a failed load says so and Try again recovers; Back always works", async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  vi.mocked(api.getSchedule).mockRejectedValueOnce(new Error("down")).mockResolvedValue(schedule({ "2026-10-20": [block()] }));
  render(<CalendarView onBack={onBack} />);
  expect(await screen.findByText(/Couldn't load your schedule/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Osmosis")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
  expect(onBack).toHaveBeenCalled();
});

test("an action that can't reach Athena says so and leaves the schedule as it was", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getSchedule).mockResolvedValue(schedule({ "2026-10-20": [block()] }));
  render(<CalendarView onBack={() => {}} />);
  await screen.findByText("Osmosis");
  vi.mocked(api.scheduleBlockAction).mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await user.click(screen.getByRole("button", { name: "Delete Osmosis (Biology)" }));
  expect(await screen.findByText(/Couldn't reach Athena/)).toBeInTheDocument();
  expect(screen.getByText("Osmosis")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Delete Osmosis (Biology)" })).toBeEnabled();
});

test("deadlines can be added from the Calendar for any subject (issue #21)", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getSchedule).mockResolvedValue(schedule());
  vi.mocked(api.listSubjects).mockResolvedValue([
    { id: "s1", name: "Biology", archived: false, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "s2", name: "History", archived: false, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "s3", name: "Old course", archived: true, createdAt: "2026-01-01T00:00:00.000Z" },
  ]);
  vi.mocked(api.listTopics).mockResolvedValue([]);
  vi.mocked(api.listDeadlines).mockResolvedValue([]);
  vi.mocked(api.createDeadline).mockResolvedValue({} as api.Deadline);
  render(<CalendarView onBack={() => {}} />);

  const picker = await screen.findByRole("combobox", { name: "Subject for deadlines" });
  expect(within(picker).queryByRole("option", { name: "Old course" })).not.toBeInTheDocument();
  await user.selectOptions(picker, "s2");
  await waitFor(() => expect(api.listDeadlines).toHaveBeenCalledWith("s2"));

  await user.click(await screen.findByRole("button", { name: "Add deadline" }));
  await user.type(screen.getByPlaceholderText("e.g. Midterm exam"), "Essay due");
  await user.type(screen.getByLabelText("Date"), "2026-11-20");
  const callsBefore = vi.mocked(api.getSchedule).mock.calls.length;
  await user.click(within(screen.getByRole("form", { name: "New deadline" })).getByRole("button", { name: "Add deadline" }));

  expect(api.createDeadline).toHaveBeenCalledWith("s2", { title: "Essay due", date: "2026-11-20", topicIds: [] });
  // The plan is rebuilt so the new deadline shows on its day.
  await waitFor(() => expect(vi.mocked(api.getSchedule).mock.calls.length).toBeGreaterThan(callsBefore));
});

test("batch move: pick single topics and a whole subject, move them to one day in one request (issue #22)", async () => {
  const user = userEvent.setup();
  const bio = (id: string, name: string) => block({ id: `2026-10-20:${id}`, topicId: id, topicName: name });
  vi.mocked(api.getSchedule).mockResolvedValue(
    schedule({
      "2026-10-20": [bio("t1", "Osmosis"), bio("t2", "Mitosis"), bio("t3", "Meiosis")],
      "2026-10-21": [block({ id: "2026-10-21:h1", topicId: "h1", topicName: "Treaty of Versailles", subjectId: "s2", subjectName: "History", date: "2026-10-21" })],
    }),
  );
  vi.mocked(api.moveScheduleBlocks).mockResolvedValue({ ok: true, schedule: schedule() });
  render(<CalendarView onBack={() => {}} />);

  const today = await waitFor(() => dayCard(/^Today ·/));
  await user.click(within(today).getByRole("checkbox", { name: "Select all Biology topics" }));
  await user.click(screen.getByRole("checkbox", { name: "Select Treaty of Versailles (History)" }));
  const bar = screen.getByRole("region", { name: "Move selected topics" });
  expect(bar).toHaveTextContent("4 topics selected");

  // Unpicking one topic inside the group leaves the group partly picked.
  await user.click(within(today).getByRole("button", { name: /Biology/ }));
  await user.click(within(today).getByRole("checkbox", { name: "Select Mitosis (Biology)" }));
  expect(within(today).getByRole("checkbox", { name: "Select all Biology topics" })).toHaveProperty("indeterminate", true);
  expect(bar).toHaveTextContent("3 topics selected");

  expect(within(bar).getByRole("button", { name: "Move" })).toBeDisabled();
  await user.selectOptions(within(bar).getByRole("combobox"), "2026-10-23");
  await user.click(within(bar).getByRole("button", { name: "Move" }));

  expect(api.moveScheduleBlocks).toHaveBeenCalledTimes(1);
  const [ids, toDate] = vi.mocked(api.moveScheduleBlocks).mock.calls[0];
  expect([...ids].sort()).toEqual(["2026-10-20:t1", "2026-10-20:t3", "2026-10-21:h1"]);
  expect(toDate).toBe("2026-10-23");
  expect(await screen.findByText(/Moved 3 topics to/)).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Move selected topics" })).not.toBeInTheDocument();
});

test("batch move refused because the schedule changed: shows why and the fresh schedule", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getSchedule).mockResolvedValue(schedule({ "2026-10-20": [block()] }));
  vi.mocked(api.moveScheduleBlocks).mockResolvedValue({ ok: false, error: "Some of those study blocks aren't on your schedule any more.", schedule: schedule() });
  render(<CalendarView onBack={() => {}} />);

  await user.click(await screen.findByRole("checkbox", { name: "Select Osmosis (Biology)" }));
  const bar = screen.getByRole("region", { name: "Move selected topics" });
  await user.selectOptions(within(bar).getByRole("combobox"), "2026-10-22");
  await user.click(within(bar).getByRole("button", { name: "Move" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/aren't on your schedule any more/);
  // Osmosis is gone from the fresh schedule, so nothing stays picked.
  expect(screen.queryByRole("region", { name: "Move selected topics" })).not.toBeInTheDocument();
});
