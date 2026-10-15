import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { UpdateControl } from "./UpdateControl";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const base: api.UpdateStatus = {
  available: true,
  current: "aaa",
  latest: "bbb",
  checkedAt: "2026-10-13T00:00:00.000Z",
  updating: false,
  blockedReason: null,
  lastUpdate: null,
};

// Issue #8: a release promoted minutes ago stayed invisible (the server
// only checks every 30 minutes) and nothing showed a check was happening.
test("opening Athena with a stale last check checks GitHub now, and shows the update it finds", async () => {
  const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  vi.mocked(api.getUpdateStatus)
    .mockResolvedValueOnce({ ...base, available: false, checkedAt: stale })
    .mockResolvedValue({ ...base, available: true, checkedAt: new Date().toISOString() });
  vi.mocked(api.checkForUpdates).mockResolvedValue();
  render(<UpdateControl onReportBug={() => {}} />);

  expect(await screen.findByText("Update available")).toBeInTheDocument();
  expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
});

test("a recent check isn't repeated on open; the quiet Check for updates control shows instead", async () => {
  vi.mocked(api.getUpdateStatus).mockResolvedValue({ ...base, available: false, checkedAt: new Date().toISOString() });
  render(<UpdateControl onReportBug={() => {}} />);
  expect(await screen.findByRole("button", { name: "Check for updates" })).toBeEnabled();
  expect(api.checkForUpdates).not.toHaveBeenCalled();
});

test("Check for updates says so when there's nothing new", async () => {
  const user = userEvent.setup();
  vi.mocked(api.getUpdateStatus).mockResolvedValue({ ...base, available: false, checkedAt: new Date().toISOString() });
  vi.mocked(api.checkForUpdates).mockResolvedValue();
  render(<UpdateControl onReportBug={() => {}} />);

  await user.click(await screen.findByRole("button", { name: "Check for updates" }));
  expect(api.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("button", { name: "Up to date ✓" })).toBeInTheDocument();
});

test("a failed check says so (with the reason on hover) and offers a retry", async () => {
  vi.mocked(api.getUpdateStatus).mockResolvedValue({
    ...base,
    available: false,
    checkedAt: new Date().toISOString(),
    error: "git fetch failed: Could not resolve host: github.com",
  });
  render(<UpdateControl onReportBug={() => {}} />);
  const retry = await screen.findByRole("button", { name: "Couldn't check for updates · Retry" });
  expect(retry).toHaveAttribute("title", expect.stringMatching(/Could not resolve host/));
});

test("during a Live turn the button is disabled and says why", async () => {
  vi.mocked(api.getUpdateStatus).mockResolvedValue({ ...base, blockedReason: "Athena is in the middle of working on something." });
  render(<UpdateControl onReportBug={() => {}} />);
  expect(await screen.findByText("Update available")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Update now" })).toBeDisabled();
  expect(screen.getByText("Available when Athena finishes")).toHaveAttribute("title", expect.stringMatching(/middle of working/));
});

test("confirm → apply → overlay → reloads once the new commit answers", async () => {
  vi.mocked(api.getUpdateStatus).mockResolvedValue(base);
  vi.mocked(api.applyUpdate).mockResolvedValue({ ok: true, from: "aaa", to: "bbb" });
  vi.mocked(api.getHealth)
    .mockRejectedValueOnce(new Error("down"))
    .mockResolvedValue({ ok: true, commit: "bbb" });
  const reload = vi.fn();
  render(<UpdateControl onReportBug={() => {}} pollMs={5} reload={reload} />);

  await userEvent.click(await screen.findByRole("button", { name: "Update now" }));
  expect(screen.getByText(/restart for about a minute; your work is saved/)).toBeInTheDocument();
  expect(api.applyUpdate).not.toHaveBeenCalled();
  await userEvent.click(screen.getAllByRole("button", { name: "Update now" }).at(-1)!);

  expect(api.applyUpdate).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Updating…")).toBeInTheDocument();
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

test("a refused start shows the server's reason in the dialog", async () => {
  vi.mocked(api.getUpdateStatus).mockResolvedValue(base);
  vi.mocked(api.applyUpdate).mockResolvedValue({ ok: false, reason: "Athena is already up to date." });
  render(<UpdateControl onReportBug={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Update now" }));
  await userEvent.click(screen.getAllByRole("button", { name: "Update now" }).at(-1)!);
  expect(await screen.findByText("Athena is already up to date.")).toBeInTheDocument();
  expect(screen.queryByText("Updating…")).not.toBeInTheDocument();
});

test("a rolled-back update says so plainly, doesn't reload, and offers a bug report", async () => {
  vi.mocked(api.applyUpdate).mockResolvedValue({ ok: true, from: "aaa", to: "bbb" });
  vi.mocked(api.getHealth).mockResolvedValue({ ok: true, commit: "aaa" });
  const later = new Date(Date.now() + 60_000).toISOString();
  vi.mocked(api.getUpdateStatus)
    .mockResolvedValueOnce(base)
    .mockResolvedValueOnce(base)
    .mockResolvedValue({ ...base, lastUpdate: { result: "rolled-back", runningCommit: "aaa", finishedAt: later } });
  const reload = vi.fn();
  const onReportBug = vi.fn();
  render(<UpdateControl onReportBug={onReportBug} pollMs={5} reload={reload} />);

  await userEvent.click(await screen.findByRole("button", { name: "Update now" }));
  await userEvent.click(screen.getAllByRole("button", { name: "Update now" }).at(-1)!);

  expect(await screen.findByText("Update didn't work")).toBeInTheDocument();
  expect(screen.getByText(/still on the previous version/)).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Report a bug" }));
  expect(onReportBug).toHaveBeenCalledTimes(1);
});

test("an update result from before this attempt is ignored while waiting", async () => {
  vi.mocked(api.applyUpdate).mockResolvedValue({ ok: true, from: "aaa", to: "bbb" });
  const old = { result: "rolled-back" as const, finishedAt: "2020-01-01T00:00:00.000Z" };
  vi.mocked(api.getUpdateStatus).mockResolvedValue({ ...base, lastUpdate: old });
  vi.mocked(api.getHealth)
    .mockResolvedValueOnce({ ok: true, commit: "aaa" })
    .mockResolvedValueOnce({ ok: true, commit: "aaa" })
    .mockResolvedValue({ ok: true, commit: "bbb" });
  const reload = vi.fn();
  render(<UpdateControl onReportBug={() => {}} pollMs={5} reload={reload} />);
  await userEvent.click(await screen.findByRole("button", { name: "Update now" }));
  await userEvent.click(screen.getAllByRole("button", { name: "Update now" }).at(-1)!);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("Update didn't work")).not.toBeInTheDocument();
});

test("a cancelled update (Athena was busy) explains that nothing changed", async () => {
  vi.mocked(api.applyUpdate).mockResolvedValue({ ok: true, from: "aaa", to: "bbb" });
  vi.mocked(api.getHealth).mockResolvedValue({ ok: true, commit: "aaa" });
  const later = new Date(Date.now() + 60_000).toISOString();
  vi.mocked(api.getUpdateStatus)
    .mockResolvedValueOnce(base)
    .mockResolvedValueOnce(base)
    .mockResolvedValue({ ...base, lastUpdate: { result: "cancelled", finishedAt: later } });
  render(<UpdateControl onReportBug={() => {}} pollMs={5} reload={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Update now" }));
  await userEvent.click(screen.getAllByRole("button", { name: "Update now" }).at(-1)!);
  expect(await screen.findByText("Update cancelled")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Report a bug" })).not.toBeInTheDocument();
});
