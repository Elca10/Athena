# Athena-Studying

A local study app built on *Make It Stick*: retrieval practice, spaced
repetition, interleaving, calibration. It runs on your own Claude Code
login — there's no separate account or API key for Athena-Studying
itself.

## Setup

First time with Claude Code or GitHub? Do every step in order (about 20
minutes). Already set up? Skip to step 7.

### 1. Make your accounts (in your browser)

- **Claude, Pro plan or higher:** sign up at [claude.ai](https://claude.ai),
  then upgrade to Pro at [claude.com/pricing](https://claude.com/pricing).
  The free plan doesn't include Claude Code. Max, Team and Enterprise
  work too.
- **GitHub (free):** sign up at [github.com/signup](https://github.com/signup)
  and confirm your email. Your username is public on any bug report you
  send.

### 2. Open a terminal

- **Windows:** Start menu → type **PowerShell** → open **Windows
  PowerShell**.
- **Mac:** `Cmd+Space` → type **Terminal** → Enter.

Run commands one line at a time: paste, press Enter, and wait for an
empty prompt before the next. On Mac, a password prompt wants your Mac login
password; nothing shows as you type, which is normal.

### 3. Mac only: install Homebrew

Skip this if `brew --version` prints a version number.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

When it finishes, if it printed a **Next steps** section, run the
commands listed there too.

### 4. Install Claude Code and GitHub CLI

**Windows:**

```powershell
irm https://claude.ai/install.ps1 | iex
winget install --id GitHub.cli -e --source winget
```

**Mac:**

```bash
curl -fsSL https://claude.ai/install.sh | bash
brew install gh
```

### 5. Close the terminal and open a new one

Newly installed programs only work in a new window. Check both:

```
claude --version
gh --version
```

Each should print a version number. If not, close the window and try a
new one again; if it still fails, see Claude Code's
[install troubleshooting](https://code.claude.com/docs/en/troubleshoot-install).

### 6. Log in to both

**Claude Code:**

```
claude
```

Pick any theme, choose **Claude account with subscription**, and sign in
and click **Authorize** in the browser window that opens. If it asks
whether to trust this folder, say yes. When you see a box to type in,
type `/exit` and press Enter.

**GitHub:**

```
gh auth login --hostname github.com --git-protocol https --web
```

Press Enter at any question, copy the one-time code it shows, then paste
it in the browser page that opens and click **Authorize**. Check with
`gh auth status`, which should say you're logged in.

### 7. Install Athena-Studying

In the same terminal:

**Windows:**

```powershell
irm https://raw.githubusercontent.com/Elca10/Athena/release/installers/windows.ps1 | iex
```

**Mac:**

```bash
curl -fsSL https://raw.githubusercontent.com/Elca10/Athena/release/installers/macos.sh | sh
```

It installs `git` and `Node.js` if needed (approve any Windows
permission prompt), downloads Athena-Studying into an `Athena-Studying`
folder in your home folder, opens it in your browser, and (on Mac) adds an
**Athena-Studying** app for reopening it later. The first run
takes a few minutes. A short setup wizard then confirms Claude Code and
GitHub are ready and has you create your first subject.

### If something fails

- **The installer stops with an error:** do what it says (usually: open
  a new terminal), then run the step 7 command again. It's safe to
  re-run.
- **A wizard check still fails after you fixed it:** Athena only notices
  some fixes when it restarts. [Stop Athena](#stopping-athena-studying),
  open a new terminal, and run the step 7 command again.

## Reopening Athena-Studying

- **Windows:** use the **Athena-Studying** shortcut on your Desktop or
  Start menu.
- **Mac:** open **Athena-Studying** from Launchpad or Spotlight
  (`Cmd+Space`, type *Athena*). It lives in the Applications folder in
  your home folder; drag it to your Dock to keep it handy. Installed
  before the app existed? Run the step 7 command once to add it.

Either way, it opens your browser to Athena, starting it first (and
checking for updates) if it isn't running. That can take up to a minute
after an update. Your study data is never touched. If the Mac app can't
start Athena, it says so; run the step 7 command in Terminal to see why.

## Stopping Athena-Studying

Closing the browser tab leaves Athena running in the background. To stop
it, restart your computer or run:

- **Windows** (PowerShell):
  `Get-NetTCPConnection -LocalPort 4417 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }`
- **Mac** (Terminal): `lsof -ti tcp:4417 -sTCP:LISTEN | xargs kill`

## Updating

When a new version is out, an **Update available** button appears at the
top of the dashboard. Click **Update now** and wait about a minute;
Athena restarts and reloads itself. Your subjects and progress are kept,
and an unfinished session waits in the **Waiting** list.

- The button is greyed out while Athena is busy (a Live question,
  grading, or reading content). Try again once it's done.
- If the new version fails to start, Athena puts the old one back and
  tells you. Please **Report a bug** when that happens.
- If the button doesn't work, [stop Athena](#stopping-athena-studying)
  and [reopen it](#reopening-athena-studying); that picks up the newest
  version.

## Reporting a bug

Click **Report a bug** on the dashboard, describe what you were doing,
what you expected, and what happened, then click **Preview report**.

Athena adds its version, your operating system and recent errors, with
personal details (file paths, your username, subject and topic names)
removed. You see the exact text before anything is sent. **Send** posts
it as a **public** GitHub issue under your GitHub username, and Athena
shows you the link.

## Uninstalling

[Stop Athena](#stopping-athena-studying), then delete its app folder,
its data folder (your subjects and progress), and its shortcuts or
app:

**Windows** (PowerShell):

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\Athena-Studying"
Remove-Item -Recurse -Force "$env:APPDATA\Athena-Studying"
Remove-Item -Force "$env:USERPROFILE\Desktop\Athena-Studying.lnk"
Remove-Item -Force "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Athena-Studying.lnk"
```

**Mac** (Terminal):

```bash
rm -rf ~/Athena-Studying
rm -rf ~/Library/Application\ Support/Athena-Studying
rm -rf ~/Applications/Athena-Studying.app ~/Library/Logs/Athena-Studying
```

## For maintainers

See [SPEC.md](SPEC.md) for the full design and build order.

### How to ship an update

Installed copies auto-update from the `release` branch, not `main` — so
pushing to `main` (including an unattended overnight build run) never
reaches anyone until you deliberately promote it. To ship whatever is
currently on `main`:

```bash
node scripts/promote-release.mjs <main-commit-sha>            # v0.4.1 -> v0.4.2
node scripts/promote-release.mjs <main-commit-sha> --minor    # v0.4.1 -> v0.5.0
node scripts/promote-release.mjs <main-commit-sha> --major    # v0.4.1 -> v1.0.0
```

This fast-forwards `release` to that commit and tags it with the next
version, but only if CI has already finished green for it — otherwise it
refuses and exits non-zero. Branch and tag are pushed atomically (both or
neither). It never force-pushes: a plain `git push` with no `--force` is
the actual enforcement, so a `release` that's somehow diverged (it
shouldn't) will fail loudly instead of being silently rewritten. Running
it again on an already-released commit does nothing.

Versions follow semver: patch for fixes, `--minor` for new features or
visible behaviour changes, `--major` for changes that break existing
installs or data. These meanings hold before 1.0 too (a new feature in
0.x is still `--minor`), so nothing changes at `1.0.0` — the deliberate
public-launch version — except that they become promises to users. Pushing the
tag runs `.github/workflows/release.yml`, which publishes a GitHub Release
whose notes are the commit subjects since the previous version — so write
commit subjects for a reader. The app shows the version it's running
(health and bug reports) and the version on offer, with a link to its
release notes.

Once `release` moves, every running copy shows **Update available**
within about half an hour (the server re-checks `release` every 30
minutes, and on every start). Clicking it runs `installers/updater.mjs`,
which keeps a log at `<data dir>/logs/updater.log` and writes the outcome
to `<data dir>/updater/last-update.json`; ask for those if an update
misbehaves. A copy that can't use the button gets the update the next
time it starts (shortcut or install command).

For local testing without touching the real channel, both
`installers/windows.ps1` and `installers/macos.sh` honor an
`ATHENA_UPDATE_BRANCH` env override (defaults to `release`) for which
branch they clone/update from; the server's update check and the updater
honor the same variable.
