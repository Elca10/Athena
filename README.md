# Athena-Studying

A local study app built on *Make It Stick*: retrieval practice, spaced
repetition, interleaving, calibration. It runs on your own Claude Code
login — there's no separate account or API key for Athena-Studying
itself.

## Before you install

You'll need two accounts and two small programs. If you've never used
Claude, Claude Code, or GitHub before, follow every step below in order
(about 20 minutes). If you already have some of it, skip those steps.

- **A Claude account on the Pro plan or higher.** Athena-Studying runs
  entirely on your own Claude Code login to ask you questions, grade
  your answers, and pull the main ideas out of whatever you upload. It
  has no AI access of its own. Claude's free plan doesn't include Claude
  Code, so Pro (or Max/Team/Enterprise) is required.
- **A free GitHub account.** Only used so that if you ever report a bug,
  it's posted from your own account. Nothing else in the app uses it.
- **Claude Code** (the program Athena-Studying talks to Claude through)
  and **GitHub CLI** (the program it files bug reports through).

### Step 1: Create a Claude account and subscribe to Pro

1. Go to [claude.ai](https://claude.ai) and sign up (with your email or a
   Google account). Confirm your email if asked.
2. Upgrade to **Pro**: open the menu under your name or initials
   (bottom-left corner) and choose **Upgrade plan**, or go to
   [claude.com/pricing](https://claude.com/pricing). Pick **Pro** and
   pay. (Already have Max, Team, or Enterprise through work or school?
   That works too.)

### Step 2: Create a GitHub account

1. Go to [github.com/signup](https://github.com/signup) and follow the
   prompts: email, a password, and a username. Your username is public
   (it's shown on any bug report you send), so pick one you're happy
   for others to see.
2. GitHub emails you a code to confirm your address. Enter it, and you're
   done. You can skip any questions about teams or plans; the free plan
   is all you need.

### Step 3: Open a terminal

The rest of setup happens by pasting commands into a terminal (a window
where you type commands instead of clicking). You only need it for setup.

- **Windows:** click Start, type **PowerShell**, and open **Windows
  PowerShell** (not "PowerShell ISE"). Paste with `Ctrl+V` or a right-click.
- **Mac:** press `Cmd+Space`, type **Terminal**, and press Enter. Paste
  with `Cmd+V`.

To run a command: paste it, press Enter, and wait until the window shows
a blinking cursor on a new, empty line before running the next one. Some
commands print nothing for a minute or two while they download; that's
normal. A command asking for your **password** on Mac wants your Mac's
login password. Nothing appears on screen as you type it; that's
normal too, just type it and press Enter.

### Step 4 (Mac only): Install Homebrew

[Homebrew](https://brew.sh) is the Mac's standard tool for installing
programs from the terminal. Athena-Studying's installer uses it, and so
does Step 6. Already have it? Run `brew --version`; if it prints a
version number, skip to Step 5.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It asks for your password, then asks you to press Enter to continue. It
may also install Apple's "Command Line Tools", which can take 10+
minutes. **When it finishes, read the end of what it printed:** if
there's a **Next steps** section with commands in it, copy and run
those commands too (they make the `brew` command work in new windows).
Then close Terminal and open a new window.

### Step 5: Install Claude Code and log in

**Windows** (PowerShell):

```powershell
irm https://claude.ai/install.ps1 | iex
```

**Mac** (Terminal):

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

When it finishes, **close the terminal window and open a new one** (so it
picks up the newly installed program), then check it worked:

```
claude --version
```

You should see a version number. If you see "not recognized" or
"command not found" instead, see Claude Code's
[installation troubleshooting](https://code.claude.com/docs/en/troubleshoot-install).

Now log in. Run:

```
claude
```

The first time, Claude Code asks a few questions:

1. Pick a color theme (any is fine).
2. Pick how to log in: choose **Claude account with subscription**.
3. Your browser opens to claude.ai. Sign in with the account from Step 1
   if you're not already, and click **Authorize**.
4. Back in the terminal you should see that login succeeded. Press Enter
   through any remaining notes. If it asks whether you trust the files in
   the current folder, that's about the folder the terminal is in, not
   Athena-Studying; choosing yes is fine.

Once you see a prompt box waiting for you to type, you're logged in. Type
`/exit` and press Enter to leave Claude Code. You won't need to open it
yourself again; Athena-Studying uses it in the background.

### Step 6: Install GitHub CLI

**Windows** (PowerShell):

```powershell
winget install --id GitHub.cli -e --source winget
```

Approve the Windows permissions prompt if one appears.

**Mac** (Terminal):

```bash
brew install gh
```

Then close the terminal window and open a new one, and check it worked:

```
gh --version
```

You don't need to log in to GitHub here. The setup wizard does that with
a **Connect GitHub** button after you install.

### Checklist

Before going on, you should have:

- [ ] A Claude account on Pro or higher
- [ ] A GitHub account
- [ ] `claude --version` and `gh --version` both print a version number
      in a **new** terminal window
- [ ] Logged in to Claude Code (Step 5)

Keep that new terminal window open: the install command below goes in
it.

## Install on Windows

Open **PowerShell** (search for it in the Start Menu — the plain
blue/black icon, not "PowerShell ISE") and paste this, then press Enter:

```powershell
irm https://raw.githubusercontent.com/Elca10/Athena/release/installers/windows.ps1 | iex
```

What happens next:

1. If `git` or `Node.js` aren't already on your computer, the installer
   installs them for you via `winget` (Windows' built-in app installer) —
   you may see a Windows admin/permissions prompt; approve it.
2. It downloads Athena-Studying into a new `Athena-Studying` folder in
   your user folder, and creates a shortcut to reopen it later (see
   "Reopening Athena-Studying" below).
3. It installs Athena-Studying's own dependencies and starts it up — this
   can take a few minutes the first time.
4. Your browser opens automatically to the app, and a short **setup
   wizard** walks you through confirming you're on Windows, checking
   that Claude Code and GitHub are installed and signed in (connecting
   GitHub with one button, and telling you exactly what to run if
   anything from "Before you install" is missing), and creating your
   first subject.

If anything fails partway through, re-run the same command — it's safe to
run more than once.

## Install on Mac

Open **Terminal** (search for it in Spotlight, the magnifying glass in
the top-right corner) and paste this, then press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/Elca10/Athena/release/installers/macos.sh | sh
```

What happens next is the same as Windows above, minus the admin prompts:
if `git` or `Node.js` are missing, the installer installs them via
Homebrew (which it needs you to have installed already, in Step 4 of
"Before you install"); Athena-Studying downloads into `Athena-Studying` in your
home folder, starts up, and opens in your browser, where the same setup
wizard walks you through Claude Code, GitHub, and your first subject.

> A relaunch shortcut (like Windows gets) isn't built yet on Mac — see
> "Reopening Athena-Studying" below for what to do instead in the
> meantime.

## Reopening Athena-Studying

**Windows:** use the **Athena-Studying** shortcut the installer added to
your Desktop and Start Menu. It reopens the app if it's already running,
or starts it (and checks for updates) if it isn't — either way, it just
opens your browser to the right page.

**Mac:** there's no shortcut yet. Open Terminal and run the same install
command again:

```bash
curl -fsSL https://raw.githubusercontent.com/Elca10/Athena/release/installers/macos.sh | sh
```

It's safe to run any time — if Athena-Studying is already running, it
just opens your browser; otherwise it starts it up first (checking for
updates along the way). Your subjects and study data live outside the
app's folder and are never touched by this.

## Updating

When a new version is out, an **Update available** button shows up at
the top of the dashboard (Athena checks every half hour). Click
**Update now**, confirm, and wait about a minute: Athena restarts by
itself and the page reloads on the new version. Your subjects, content
and study progress are kept; a study session you were in the middle of
waits for you in the **Waiting** list.

- The button is greyed out while Athena is in the middle of something
  (a Live question, grading, or reading new content). Try again once
  it's done.
- If the new version doesn't start properly, Athena puts the previous
  version back automatically and tells you, so you're never left
  without a working app. Please use **Report a bug** when that happens.

**If the button doesn't work** (or you're on a version from before it
existed): stop Athena-Studying, then reopen it as above. Reopening picks
up the newest version. Closing the browser tab leaves Athena running in
the background, so stop it first with one of these (or just restart
your computer):

- **Mac** (Terminal): `lsof -ti tcp:4417 -sTCP:LISTEN | xargs kill`
- **Windows** (PowerShell): `Get-NetTCPConnection -LocalPort 4417 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }`

## Reporting a bug

Click **Report a bug** at the top of the dashboard. Describe what went
wrong — what you were doing, what you expected, and what happened
instead — then click **Preview report**.

Athena adds a few technical details automatically (its version, your
operating system, and any recent error messages), with anything personal
— file paths, your username, your subject and topic names — removed
first. You'll see the exact text before anything is sent: review it, then
click **Send**, or **Back** to change your description first.

Sending posts a public GitHub issue (this requires the free GitHub
account set up during install), visible to anyone along with your GitHub
username — the preview screen says so too. Once sent, Athena shows you a
link to the issue it created, or a plain-language explanation if sending
didn't work (for example, if you're not signed in to GitHub or you're
offline).

## Uninstalling

Uninstalling means three things: stop the running app, then delete the
folder it was installed into, the folder it stored your data in, and its
shortcuts.

**Windows:**

1. Stop the app: press `Ctrl+Shift+Esc` to open Task Manager, find
   **Node.js JavaScript Runtime** in the list, select it, and click
   **End Task**.
2. Delete the install folder: `%USERPROFILE%\Athena-Studying`
3. Delete your data (subjects, content, progress): `%APPDATA%\Athena-Studying`
4. Delete the shortcuts:
   `%USERPROFILE%\Desktop\Athena-Studying.lnk` and
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Athena-Studying.lnk`

You can delete all of these from File Explorer (paste each path into the
address bar), or run this from PowerShell:

```powershell
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force "$env:USERPROFILE\Athena-Studying"
Remove-Item -Recurse -Force "$env:APPDATA\Athena-Studying"
Remove-Item -Force "$env:USERPROFILE\Desktop\Athena-Studying.lnk"
Remove-Item -Force "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Athena-Studying.lnk"
```

(The first line stops *all* Node.js programs on your computer — fine on a
personal laptop that's only running Athena-Studying, but close any other
Node-based app first if you're not sure.)

**Mac:**

1. Stop the app: open **Activity Monitor** (Spotlight search), find
   **node** in the list, select it, and click the stop icon (**Force
   Quit** if asked).
2. Delete the install folder: `~/Athena-Studying`
3. Delete your data: `~/Library/Application Support/Athena-Studying`

Or from Terminal:

```bash
pkill -f "server/src/index.js"
rm -rf ~/Athena-Studying
rm -rf ~/Library/Application\ Support/Athena-Studying
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
