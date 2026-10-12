import express from "express";
import { checkClaudeCode, checkGh, detectOs } from "../setupChecks.js";
import { startGithubConnect, getGithubConnectState } from "../githubConnect.js";
import { markSetupComplete } from "../setupState.js";

export function makeSetupRouter(appDataDir) {
  const setupRouter = express.Router();

  // Step 1: which computer is this? Pre-selects the wizard's OS step; the
  // user still confirms explicitly (setupChecks.js's detectOs doc comment).
  setupRouter.get("/os", (_req, res) => {
    res.json({ detected: detectOs() });
  });

  // Step 2: Claude Code installed + logged in.
  setupRouter.get("/claude-code", async (_req, res) => {
    const result = await checkClaudeCode();
    res.json(result);
  });

  // Step 3: GitHub CLI installed + authenticated (checked first, before
  // offering to start a new login flow — most friends will already have
  // `gh` authenticated from prior use).
  setupRouter.get("/github", async (_req, res) => {
    const result = await checkGh();
    res.json(result);
  });

  setupRouter.post("/github/connect", (_req, res) => {
    const id = startGithubConnect();
    res.json({ id });
  });

  setupRouter.get("/github/connect/:id", (req, res) => {
    const state = getGithubConnectState(req.params.id);
    if (!state) {
      res.status(404).json({ error: "No such connect flow (or a newer one has replaced it)." });
      return;
    }
    res.json(state);
  });

  // Step 4: marks first-run setup as done so the wizard doesn't show
  // again. Subject creation itself (or skipping it) happens client-side
  // in the wizard before this is called; this just records that the
  // one-time setup flow finished.
  setupRouter.post("/complete", async (_req, res) => {
    await markSetupComplete(appDataDir);
    res.json({ ok: true });
  });

  return setupRouter;
}
