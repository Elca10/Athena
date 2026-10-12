# Athena-Studying

A local study app built on *Make It Stick*: retrieval practice, spaced
repetition, interleaving, calibration. It runs on your own Claude Code
login — there's no separate account or API key for Athena-Studying
itself.

## Before you install

You'll need two accounts, both free to get (one needs a paid plan):

- **A Claude account, Pro or higher.** Athena-Studying runs entirely on
  your own Claude Code login to ask you questions, grade your answers,
  and pull the main ideas out of whatever you upload. It never has its
  own separate AI access — Claude's free plan doesn't include Claude
  Code, so Pro (or Max/Team/Enterprise) is required.
- **A free GitHub.com account.** Only used so that if you ever report a
  bug, it's posted from your own account — nothing else in the app uses
  it. Don't have one? Create it at `github.com/signup`, it takes about a
  minute.

You don't need to set either of these up in advance — the setup wizard
checks for both right after install and walks you through getting them if
you don't have them yet.

## Install on Windows

Open **PowerShell** (search for it in the Start Menu — the plain
blue/black icon, not "PowerShell ISE") and paste this, then press Enter:

```powershell
irm https://raw.githubusercontent.com/Elca10/Athena/main/installers/windows.ps1 | iex
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
   that Claude Code and GitHub are installed and signed in (with an
   install button for each if they're missing), and creating your first
   subject.

If anything fails partway through, re-run the same command — it's safe to
run more than once.

## Install on Mac

Open **Terminal** (search for it in Spotlight, the magnifying glass in
the top-right corner) and paste this, then press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/Elca10/Athena/main/installers/macos.sh | sh
```

What happens next is the same as Windows above, minus the admin prompts:
if `git` or `Node.js` are missing, the installer installs them via
[Homebrew](https://brew.sh) (installing Homebrew itself first if you
don't have it); Athena-Studying downloads into `Athena-Studying` in your
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
curl -fsSL https://raw.githubusercontent.com/Elca10/Athena/main/installers/macos.sh | sh
```

It's safe to run any time — if Athena-Studying is already running, it
just opens your browser; otherwise it starts it up first (checking for
updates along the way).

## Reporting a bug

There's no in-app "Report a bug" button yet. For now, if something looks
wrong or breaks, tell whoever set Athena-Studying up for you, with as
much detail as you can (what you were doing, what you expected, and what
happened instead).

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
