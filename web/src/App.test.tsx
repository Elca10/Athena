import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";
import * as api from "./setup/api";
import * as dashboardApi from "./dashboard/api";

vi.mock("./setup/api");
vi.mock("./dashboard/api");

afterEach(() => {
  vi.restoreAllMocks();
});

test("shows the setup wizard when setup isn't complete", async () => {
  vi.mocked(api.getHealth).mockResolvedValue({ ok: true, version: "0.1.0", setupComplete: false });
  vi.mocked(api.detectOs).mockResolvedValue({ detected: "mac" });
  vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: true });
  render(<App />);
  expect(await screen.findByText("Set up Athena-Studying")).toBeInTheDocument();
});

test("shows the dashboard when setup is already complete", async () => {
  vi.mocked(api.getHealth).mockResolvedValue({ ok: true, version: "0.1.0", setupComplete: true });
  vi.mocked(dashboardApi.listSubjects).mockResolvedValue([]);
  vi.mocked(dashboardApi.listSessions).mockResolvedValue([]);
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Athena" })).toBeInTheDocument();
});

test("an unreachable server shows a message with Try again, not 'Loading...' forever", async () => {
  vi.mocked(api.getHealth)
    .mockRejectedValueOnce(new Error("Failed to fetch"))
    .mockResolvedValue({ ok: true, version: "0.1.0", setupComplete: false });
  vi.mocked(api.detectOs).mockResolvedValue({ detected: "mac" });
  render(<App />);
  expect(await screen.findByText(/Couldn't reach Athena/)).toBeInTheDocument();
  screen.getByRole("button", { name: "Try again" }).click();
  expect(await screen.findByText("Set up Athena-Studying")).toBeInTheDocument();
});
