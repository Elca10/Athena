import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ReportBugPanel } from "./ReportBugPanel";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test("Preview is disabled until a description is typed, then shows the server's exact preview", async () => {
  vi.mocked(api.previewBugReport).mockResolvedValue({ title: "Bug report: it crashed", body: "it crashed\n\n---\nDiagnostics" });
  render(<ReportBugPanel onClose={() => {}} />);

  expect(screen.getByRole("button", { name: "Preview report" })).toBeDisabled();

  await userEvent.type(screen.getByPlaceholderText(/What went wrong/), "it crashed");
  expect(screen.getByRole("button", { name: "Preview report" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Preview report" }));

  expect(api.previewBugReport).toHaveBeenCalledWith("it crashed");
  expect(await screen.findByText("Bug report: it crashed")).toBeInTheDocument();
  expect(screen.getByText(/Diagnostics/)).toBeInTheDocument();
  // "public" sits inside a <strong>, a separate text node from the rest of
  // the sentence — checking the warning element's own textContent avoids
  // the known RTL pitfall where a regex can't span a sibling text-node
  // boundary (see ada.json's React Testing Library lesson).
  expect(document.querySelector(".bug-report-warning")?.textContent).toMatch(/public.*GitHub issue/i);
});

test("nothing is sent until the user clicks Send on the preview screen", async () => {
  vi.mocked(api.previewBugReport).mockResolvedValue({ title: "t", body: "b" });
  render(<ReportBugPanel onClose={() => {}} />);

  await userEvent.type(screen.getByPlaceholderText(/What went wrong/), "it crashed");
  await userEvent.click(screen.getByRole("button", { name: "Preview report" }));
  await screen.findByText("t");

  expect(api.sendBugReport).not.toHaveBeenCalled();
});

test("Back from the preview screen returns to editing without sending", async () => {
  vi.mocked(api.previewBugReport).mockResolvedValue({ title: "t", body: "b" });
  render(<ReportBugPanel onClose={() => {}} />);

  await userEvent.type(screen.getByPlaceholderText(/What went wrong/), "it crashed");
  await userEvent.click(screen.getByRole("button", { name: "Preview report" }));
  await screen.findByText("t");

  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByPlaceholderText(/What went wrong/)).toHaveValue("it crashed");
  expect(api.sendBugReport).not.toHaveBeenCalled();
});

test("Send files the exact previewed title/body and shows the resulting issue URL as a link", async () => {
  vi.mocked(api.previewBugReport).mockResolvedValue({ title: "Bug report: it crashed", body: "full body" });
  vi.mocked(api.sendBugReport).mockResolvedValue({ ok: true, url: "https://github.com/Elca10/Athena/issues/42" });
  render(<ReportBugPanel onClose={() => {}} />);

  await userEvent.type(screen.getByPlaceholderText(/What went wrong/), "it crashed");
  await userEvent.click(screen.getByRole("button", { name: "Preview report" }));
  await screen.findByText("Bug report: it crashed");

  await userEvent.click(screen.getByRole("button", { name: "Send" }));

  expect(api.sendBugReport).toHaveBeenCalledWith({ title: "Bug report: it crashed", body: "full body" });
  const link = await screen.findByRole("link", { name: "View the issue" });
  expect(link).toHaveAttribute("href", "https://github.com/Elca10/Athena/issues/42");
});

test("a failed send shows the plain-language error, not a raw gh error dump", async () => {
  vi.mocked(api.previewBugReport).mockResolvedValue({ title: "t", body: "b" });
  vi.mocked(api.sendBugReport).mockResolvedValue({ ok: false, error: "Not signed in to GitHub. Run `gh auth login`, then try again." });
  render(<ReportBugPanel onClose={() => {}} />);

  await userEvent.type(screen.getByPlaceholderText(/What went wrong/), "it crashed");
  await userEvent.click(screen.getByRole("button", { name: "Preview report" }));
  await screen.findByText("t");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));

  expect(await screen.findByText(/Not signed in to GitHub/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "View the issue" })).not.toBeInTheDocument();
});

test("Close calls onClose from the describe screen", async () => {
  const onClose = vi.fn();
  render(<ReportBugPanel onClose={onClose} />);
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalled();
});

test("Done on the result screen calls onClose", async () => {
  vi.mocked(api.previewBugReport).mockResolvedValue({ title: "t", body: "b" });
  vi.mocked(api.sendBugReport).mockResolvedValue({ ok: true, url: "https://github.com/Elca10/Athena/issues/1" });
  const onClose = vi.fn();
  render(<ReportBugPanel onClose={onClose} />);

  await userEvent.type(screen.getByPlaceholderText(/What went wrong/), "it crashed");
  await userEvent.click(screen.getByRole("button", { name: "Preview report" }));
  await screen.findByText("t");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("link", { name: "View the issue" });

  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalled();
});

test("a failed preview (e.g. empty description rejected server-side) shows an error and stays on the describe screen", async () => {
  vi.mocked(api.previewBugReport).mockRejectedValue(new Error("Describe the bug before previewing."));
  render(<ReportBugPanel onClose={() => {}} />);

  await userEvent.type(screen.getByPlaceholderText(/What went wrong/), "x");
  await userEvent.click(screen.getByRole("button", { name: "Preview report" }));

  expect(await screen.findByText("Describe the bug before previewing.")).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/What went wrong/)).toBeInTheDocument();
});
