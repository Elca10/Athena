import express from "express";
import { checkClaudeCode, checkGh } from "../setupChecks.js";
import { startGithubConnect, getGithubConnectState } from "../githubConnect.js";
import { markSetupComplete } from "../setupState.js";

export function makeSetupRouter(appDataDir) {
  const setupRouter = express.Router();

  // Step 1: Claude Code installed + logged in.
  setupRouter.get("/claude-code", async (_req, res) => {
    const result = await checkClaudeCode();
    res.json(result);
  });

  // Step 2: GitHub CLI installed + authenticated (checked first, before
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

  // Step 3 (stub — real subject creation lands in build step 2): marks
  // first-run setup as done so the wizard doesn't show again. The wizard
  // itself still lets the user create a subject right away where
  // possible; this just records that the one-time setup flow finished.
  setupRouter.post("/complete", async (_req, res) => {
    await markSetupComplete(appDataDir);
    res.json({ ok: true });
  });

  return setupRouter;
}
