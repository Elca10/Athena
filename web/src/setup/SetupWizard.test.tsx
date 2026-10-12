import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SetupWizard } from "./SetupWizard";
import * as api from "./api";

vi.mock("./api");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("step 1: Claude Code", () => {
  test("Continue is disabled until the check confirms installed + logged in, then advances to step 2", async () => {
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: false });
    const user = userEvent.setup();
    render(<SetupWizard onComplete={vi.fn()} />);

    expect(await screen.findByText(/isn't installed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: true });
    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByText("Claude Code is installed and logged in.")).toBeInTheDocument();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeEnabled();

    await user.click(continueButton);
    expect(screen.getByText(/Bug reports/)).toBeInTheDocument();
  });

  test("an ambiguous (null) login result does not block continuing", async () => {
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: null, detail: "weird output" });
    render(<SetupWizard onComplete={vi.fn()} />);

    expect(await screen.findByText(/Couldn't confirm login status/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});

describe("step 2: GitHub", () => {
  beforeEach(() => {
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: true });
  });

  async function advanceToStep2(user: ReturnType<typeof userEvent.setup>) {
    render(<SetupWizard onComplete={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Continue" }));
  }

  test("offers Connect GitHub when installed but not authenticated, and polls through to success", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup();
    vi.mocked(api.checkGithub).mockResolvedValue({ installed: true, authenticated: false });
    await advanceToStep2(user);

    const connectButton = await screen.findByRole("button", { name: "Connect GitHub" });
    vi.mocked(api.startGithubConnect).mockResolvedValue({ id: "flow-1" });
    vi.mocked(api.getGithubConnectState).mockResolvedValue({
      id: "flow-1",
      status: "pending",
      rawOutput: "",
      code: "ABCD-1234",
      verificationUrl: "https://github.com/login/device",
      startedAt: Date.now(),
    });
    await user.click(connectButton);

    expect(await screen.findByText(/ABCD-1234/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    vi.mocked(api.getGithubConnectState).mockResolvedValue({
      id: "flow-1",
      status: "success",
      rawOutput: "Logged in",
      code: "ABCD-1234",
      verificationUrl: "https://github.com/login/device",
      startedAt: Date.now(),
    });
    vi.mocked(api.checkGithub).mockResolvedValue({ installed: true, authenticated: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(await screen.findByText("GitHub is connected.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    vi.useRealTimers();
  });

  test("Back returns to step 1", async () => {
    const user = userEvent.setup();
    vi.mocked(api.checkGithub).mockResolvedValue({ installed: true, authenticated: true });
    await advanceToStep2(user);

    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByText(/own Claude Code login/)).toBeInTheDocument();
  });
});

describe("step 3: first subject", () => {
  async function advanceToStep3(user: ReturnType<typeof userEvent.setup>, onComplete = vi.fn()) {
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: true });
    vi.mocked(api.checkGithub).mockResolvedValue({ installed: true, authenticated: true });
    render(<SetupWizard onComplete={onComplete} />);
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    return onComplete;
  }

  test("'Create and finish' is disabled until a name is entered, then creates the subject and completes setup", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createSubject).mockResolvedValue({ id: "s1", name: "Organic Chemistry" });
    vi.mocked(api.completeSetup).mockResolvedValue(undefined);
    const onComplete = await advanceToStep3(user);

    const createButton = screen.getByRole("button", { name: "Create and finish" });
    expect(createButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/Subject name/), "Organic Chemistry");
    expect(createButton).toBeEnabled();
    await user.click(createButton);

    expect(api.createSubject).toHaveBeenCalledWith("Organic Chemistry");
    expect(api.completeSetup).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });

  test("'Skip for now' completes setup without creating a subject", async () => {
    const user = userEvent.setup();
    vi.mocked(api.completeSetup).mockResolvedValue(undefined);
    const onComplete = await advanceToStep3(user);

    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(api.createSubject).not.toHaveBeenCalled();
    expect(api.completeSetup).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });

  test("shows the server's error and does not finish setup if creation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createSubject).mockRejectedValue(new Error("Subject name cannot be blank."));
    const onComplete = await advanceToStep3(user);

    await user.type(screen.getByPlaceholderText(/Subject name/), "x");
    await user.click(screen.getByRole("button", { name: "Create and finish" }));

    expect(await screen.findByText("Subject name cannot be blank.")).toBeInTheDocument();
    expect(api.completeSetup).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
