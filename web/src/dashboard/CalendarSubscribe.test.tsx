import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { CalendarSubscribe, feedLink } from "./CalendarSubscribe";

afterEach(() => {
  vi.restoreAllMocks();
});

test("the feed link is this page's own host", () => {
  expect(feedLink("127.0.0.1:4417")).toBe("webcal://127.0.0.1:4417/api/schedule/feed.ics");
  expect(feedLink("localhost:5000")).toBe("webcal://localhost:5000/api/schedule/feed.ics");
});

test("shows the link, opens it in a calendar app, and copies it", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<CalendarSubscribe />);
  await user.click(screen.getByText("Show this plan in your calendar app"));
  const link = feedLink();
  expect(screen.getByLabelText("Calendar link")).toHaveValue(link);
  expect(screen.getByRole("link", { name: "Open in calendar app" })).toHaveAttribute("href", link);
  await user.click(screen.getByRole("button", { name: "Copy link" }));
  expect(writeText).toHaveBeenCalledWith(link);
  expect(screen.getByRole("status")).toHaveTextContent("Copied.");
});

test("a failed copy says how to copy it by hand", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  render(<CalendarSubscribe />);
  await user.click(screen.getByText("Show this plan in your calendar app"));
  await user.click(screen.getByRole("button", { name: "Copy link" }));
  expect(screen.getByRole("status")).toHaveTextContent("Couldn't copy. Select the link above and copy it.");
});
