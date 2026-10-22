import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { CanvasImport } from "./CanvasImport";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const SUBJECTS: api.Subject[] = [
  { id: "bio", name: "Biology", archived: false, createdAt: "2026-10-01T00:00:00.000Z" },
  { id: "csc", name: "CSC 4553", archived: false, createdAt: "2026-10-01T00:00:00.000Z" },
];

function event(overrides: Partial<api.CanvasFeedEvent> = {}): api.CanvasFeedEvent {
  return { uid: "lab", title: "Lab report", course: "Biology 101", date: "2026-10-30", imported: null, changed: false, suggestedSubjectId: "bio", ...overrides };
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("Import deadlines from Canvas"));
}

test("loads nothing until opened, then connects with a pasted link and lists events", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getCanvasFeedStatus).mockResolvedValue({ connected: false, host: null });
  vi.mocked(api.connectCanvasFeed).mockResolvedValue({ connected: true, host: "school.instructure.com" });
  vi.mocked(api.listCanvasFeedEvents).mockResolvedValue([event()]);
  vi.mocked(api.listSubjects).mockResolvedValue(SUBJECTS);
  render(<CanvasImport onImported={() => {}} />);
  expect(api.getCanvasFeedStatus).not.toHaveBeenCalled();

  await open(user);
  const connect = await screen.findByRole("button", { name: "Connect" });
  expect(connect).toBeDisabled();
  await user.type(screen.getByLabelText("Calendar feed link"), "https://school.instructure.com/feeds/calendars/user_x.ics");
  await user.click(connect);

  expect(api.connectCanvasFeed).toHaveBeenCalledWith("https://school.instructure.com/feeds/calendars/user_x.ics");
  expect(await screen.findByText("school.instructure.com")).toBeInTheDocument();
  expect(await screen.findByText("Lab report")).toBeInTheDocument();
  // The suggested subject is preselected, but nothing is ticked yet.
  expect(screen.getByLabelText("Subject for Lab report")).toHaveValue("bio");
  expect(screen.getByRole("checkbox")).not.toBeChecked();
});

test("a rejected link shows the server's reason and keeps what was typed", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getCanvasFeedStatus).mockResolvedValue({ connected: false, host: null });
  vi.mocked(api.connectCanvasFeed).mockRejectedValue(new Error("That isn't a Canvas calendar feed link."));
  render(<CanvasImport onImported={() => {}} />);
  await open(user);
  await user.type(await screen.findByLabelText("Calendar feed link"), "https://example.com");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("That isn't a Canvas calendar feed link.");
  expect(screen.getByLabelText("Calendar feed link")).toHaveValue("https://example.com");
});

test("ticked events need a subject each; adding imports per subject and refreshes the plan", async () => {
  const user = userEvent.setup();
  const onImported = vi.fn();
  vi.mocked(api.getCanvasFeedStatus).mockResolvedValue({ connected: true, host: "school.instructure.com" });
  vi.mocked(api.listSubjects).mockResolvedValue(SUBJECTS);
  vi.mocked(api.listCanvasFeedEvents).mockResolvedValue([
    event(),
    event({ uid: "hw", title: "Homework 4", course: "Algorithms", suggestedSubjectId: null }),
  ]);
  vi.mocked(api.importCanvasFeedEvents).mockImplementation(async (_s, uids) => ({ added: uids.map(() => ({}) as api.Deadline), skipped: 0 }));
  render(<CanvasImport onImported={onImported} />);
  await open(user);
  await screen.findByText("Homework 4");

  const add = screen.getByRole("button", { name: "Add to deadlines" });
  expect(add).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /Homework 4/ }));
  expect(screen.getByText("Pick a subject for each ticked event.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add 1 to deadlines" })).toBeDisabled();

  await user.selectOptions(screen.getByLabelText("Subject for Homework 4"), "csc");
  await user.click(screen.getByRole("checkbox", { name: /Lab report/ }));
  await user.click(screen.getByRole("button", { name: "Add 2 to deadlines" }));

  await waitFor(() => expect(api.importCanvasFeedEvents).toHaveBeenCalledTimes(2));
  expect(api.importCanvasFeedEvents).toHaveBeenCalledWith("bio", ["lab"]);
  expect(api.importCanvasFeedEvents).toHaveBeenCalledWith("csc", ["hw"]);
  expect(await screen.findByRole("status")).toHaveTextContent("Added 2 deadlines.");
  expect(onImported).toHaveBeenCalled();
});

test("picking a subject ticks the event", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getCanvasFeedStatus).mockResolvedValue({ connected: true, host: "h" });
  vi.mocked(api.listSubjects).mockResolvedValue(SUBJECTS);
  vi.mocked(api.listCanvasFeedEvents).mockResolvedValue([event({ suggestedSubjectId: null })]);
  render(<CanvasImport onImported={() => {}} />);
  await open(user);
  await user.selectOptions(await screen.findByLabelText("Subject for Lab report"), "bio");
  expect(screen.getByRole("checkbox", { name: /Lab report/ })).toBeChecked();
  expect(screen.getByRole("button", { name: "Add 1 to deadlines" })).toBeEnabled();
});

test("an already-added event that changed in Canvas offers Update, which patches the deadline", async () => {
  const user = userEvent.setup();
  const onImported = vi.fn();
  vi.mocked(api.getCanvasFeedStatus).mockResolvedValue({ connected: true, host: "h" });
  vi.mocked(api.listSubjects).mockResolvedValue(SUBJECTS);
  vi.mocked(api.listCanvasFeedEvents).mockResolvedValue([
    event({ uid: "exam", title: "Midterm", date: "2026-11-12", imported: { deadlineId: "d1", subjectId: "bio", title: "Midterm", date: "2026-11-05" }, changed: true }),
    event({ uid: "quiz", title: "Quiz", imported: { deadlineId: "d2", subjectId: "bio", title: "Quiz", date: "2026-10-30" } }),
  ]);
  vi.mocked(api.updateDeadline).mockResolvedValue({} as api.Deadline);
  render(<CanvasImport onImported={onImported} />);
  await open(user);

  await screen.findByText("Already added");
  expect(screen.getByText(/Canvas now says/)).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /Update/ })).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Update Midterm to match Canvas" }));
  expect(api.updateDeadline).toHaveBeenCalledWith("bio", "d1", { title: "Midterm", date: "2026-11-12" });
  expect(await screen.findByRole("status")).toHaveTextContent("Updated Midterm to match Canvas.");
  expect(onImported).toHaveBeenCalled();
});

test("a Canvas error offers Try again, and no subjects means a pointer to create one", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getCanvasFeedStatus).mockResolvedValue({ connected: true, host: "h" });
  vi.mocked(api.listSubjects).mockResolvedValue([]);
  vi.mocked(api.listCanvasFeedEvents).mockRejectedValueOnce(new Error("Couldn't reach Canvas.")).mockResolvedValue([event()]);
  render(<CanvasImport onImported={() => {}} />);
  await open(user);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't reach Canvas.");
  await user.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(await screen.findByText(/Create a subject on the dashboard first/)).toBeInTheDocument();
});

test("Disconnect asks first, then goes back to the connect form", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getCanvasFeedStatus).mockResolvedValue({ connected: true, host: "h" });
  vi.mocked(api.listSubjects).mockResolvedValue(SUBJECTS);
  vi.mocked(api.listCanvasFeedEvents).mockResolvedValue([]);
  vi.mocked(api.disconnectCanvasFeed).mockResolvedValue();
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<CanvasImport onImported={() => {}} />);
  await open(user);
  await screen.findByText("No upcoming events in your Canvas calendar.");

  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(api.disconnectCanvasFeed).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(await screen.findByLabelText("Calendar feed link")).toBeInTheDocument();
});
