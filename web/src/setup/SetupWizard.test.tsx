import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SetupWizard } from "./SetupWizard";
import * as api from "./api";

vi.mock("./api");

beforeEach(() => {
  // Every test except the OS-step's own ones cares about steps 2+; default
  // to a detected OS so those tests don't each have to mock this too.
  vi.mocked(api.detectOs).mockResolvedValue({ detected: "mac" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function advancePastOs(user: ReturnType<typeof userEvent.setup>) {
  render(<SetupWizard onComplete={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Continue" }));
}

describe("step 1: which computer", () => {
  test("pre-selects the server-detected OS, but Continue still requires it", async () => {
    vi.mocked(api.detectOs).mockResolvedValue({ detected: "windows" });
    const user = userEvent.setup();
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: true });
    render(<SetupWizard onComplete={vi.fn()} />);

    const windowsRadio = await screen.findByRole("radio", { name: "Windows" });
    expect(windowsRadio).toBeChecked();
    expect(screen.getByRole("radio", { name: "Mac" })).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/own Claude Code login/)).toBeInTheDocument();
  });

  test("an undetected OS (e.g. Linux) leaves neither radio pre-selected and blocks Continue", async () => {
    vi.mocked(api.detectOs).mockResolvedValue({ detected: "other" });
    const user = userEvent.setup();
    render(<SetupWizard onComplete={vi.fn()} />);

    await screen.findByRole("radio", { name: "Windows" });
    expect(screen.getByRole("radio", { name: "Windows" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Mac" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: "Mac" }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});

describe("step 2: Claude Code", () => {
  test("Continue is disabled until the check confirms installed + logged in, then advances to step 3", async () => {
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: false });
    const user = userEvent.setup();
    render(<SetupWizard onComplete={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/isn't installed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: true });
    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByText("Claude Code is installed and logged in.")).toBeInTheDocument();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeEnabled();

    await user.click(continueButton);
    expect(screen.getByText(/free GitHub.com account/)).toBeInTheDocument();
  });

  test("an ambiguous (null) login result does not block continuing", async () => {
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: null, detail: "weird output" });
    const user = userEvent.setup();
    await advancePastOs(user);

    expect(await screen.findByText(/Couldn't confirm login status/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  test("a Windows pick shows the winget install command instead of the Mac link", async () => {
    vi.mocked(api.detectOs).mockResolvedValue({ detected: "windows" });
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: false });
    const user = userEvent.setup();
    await advancePastOs(user);

    expect(await screen.findByText(/winget install --id Anthropic.ClaudeCode/)).toBeInTheDocument();
    expect(screen.queryByText(/claude\.ai\/code/)).not.toBeInTheDocument();
  });

  test("Back returns to the OS step", async () => {
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: true });
    const user = userEvent.setup();
    await advancePastOs(user);

    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByText(/Which computer/)).toBeInTheDocument();
  });
});

describe("step 3: GitHub", () => {
  beforeEach(() => {
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: true });
  });

  async function advanceToStep3(user: ReturnType<typeof userEvent.setup>) {
    render(<SetupWizard onComplete={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
  }

  test("offers Connect GitHub when installed but not authenticated, and polls through to success", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup();
    vi.mocked(api.checkGithub).mockResolvedValue({ installed: true, authenticated: false });
    await advanceToStep3(user);

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

  test("a Windows pick shows the winget install command instead of the Mac link", async () => {
    vi.mocked(api.detectOs).mockResolvedValue({ detected: "windows" });
    vi.mocked(api.checkGithub).mockResolvedValue({ installed: false });
    const user = userEvent.setup();
    await advanceToStep3(user);

    expect(await screen.findByText(/winget install --id GitHub\.cli/)).toBeInTheDocument();
    expect(screen.queryByText(/cli\.github\.com/)).not.toBeInTheDocument();
  });

  test("Back returns to the Claude Code step", async () => {
    const user = userEvent.setup();
    vi.mocked(api.checkGithub).mockResolvedValue({ installed: true, authenticated: true });
    await advanceToStep3(user);

    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByText(/own Claude Code login/)).toBeInTheDocument();
  });
});

describe("step 4: first subject", () => {
  async function advanceToStep4(user: ReturnType<typeof userEvent.setup>, onComplete = vi.fn()) {
    vi.mocked(api.checkClaudeCode).mockResolvedValue({ installed: true, loggedIn: true });
    vi.mocked(api.checkGithub).mockResolvedValue({ installed: true, authenticated: true });
    render(<SetupWizard onComplete={onComplete} />);
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    return onComplete;
  }

  test("'Create and finish' is disabled until a name is entered, then creates the subject and completes setup", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createSubject).mockResolvedValue({ id: "s1", name: "Organic Chemistry" });
    vi.mocked(api.completeSetup).mockResolvedValue(undefined);
    const onComplete = await advanceToStep4(user);

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
    const onComplete = await advanceToStep4(user);

    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(api.createSubject).not.toHaveBeenCalled();
    expect(api.completeSetup).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });

  test("shows the server's error and does not finish setup if creation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createSubject).mockRejectedValue(new Error("Subject name cannot be blank."));
    const onComplete = await advanceToStep4(user);

    await user.type(screen.getByPlaceholderText(/Subject name/), "x");
    await user.click(screen.getByRole("button", { name: "Create and finish" }));

    expect(await screen.findByText("Subject name cannot be blank.")).toBeInTheDocument();
    expect(api.completeSetup).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
