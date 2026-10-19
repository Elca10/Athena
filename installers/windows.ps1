# One-command installer for Athena-Studying on Windows (SPEC.md section 2).
#
#   irm <raw-url-to-this-file> | iex
#
# Mirrors installers/macos.sh exactly: this script only solves the
# chicken-and-egg problem of getting git + Node + a checkout onto a machine
# that may have neither yet, using winget (built into Windows 10 1709+ and
# Windows 11) in place of Homebrew. Everything else (checking claude/gh,
# installing npm deps, starting the server) is cross-platform Node code in
# installers/bootstrap.mjs, shared with the macOS installer.
#
# Also creates a Start Menu + Desktop shortcut back to this same script, so
# a friend can reopen Athena-Studying later without remembering the
# one-liner (SPEC-v2.md section 7 covers the macOS equivalent). The
# shortcut re-runs this whole script, so a relaunch gets the same
# auto-update + rollback path (installers/bootstrap.mjs) as a fresh
# install - except when Athena is already running, in which case Main
# below short-circuits to just opening the browser.
#
# Overridable via env for testing: ATHENA_REPO_URL, ATHENA_INSTALL_DIR,
# ATHENA_TEST_SKIP_MAIN (skip auto-running Main so a test can dot-source
# this file and call its functions directly), ATHENA_PORT (must match
# whatever the running server actually binds to), ATHENA_NO_OPEN_BROWSER,
# ATHENA_DESKTOP_DIR / ATHENA_STARTMENU_DIR (where the shortcuts get
# written - so a test never touches the real Desktop/Start Menu),
# ATHENA_UPDATE_BRANCH (which branch installs track and auto-update from -
# defaults to `release` so nothing pushed straight to `main` reaches an
# installed copy until the maintainer promotes it; see
# scripts/promote-release.mjs).

# $PSStyle only exists on PowerShell 7.2+ (not the Windows PowerShell 5.1
# that ships by default on Windows 10/11) - guard it rather than assume it.
if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }
$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:ATHENA_REPO_URL) { $env:ATHENA_REPO_URL } else { "https://github.com/Elca10/Athena.git" }
$InstallDir = if ($env:ATHENA_INSTALL_DIR) { $env:ATHENA_INSTALL_DIR } else { Join-Path $HOME "Athena-Studying" }
$MinNodeMajor = 18
# Matches bootstrap.mjs's own ATHENA_PORT/default-4417 handling exactly -
# this script and the server it starts must agree on the port to make the
# "already running" health check meaningful.
$Port = if ($env:ATHENA_PORT) { $env:ATHENA_PORT } else { 4417 }
$DesktopDir = if ($env:ATHENA_DESKTOP_DIR) { $env:ATHENA_DESKTOP_DIR } else { [Environment]::GetFolderPath("Desktop") }
$StartMenuDir = if ($env:ATHENA_STARTMENU_DIR) { $env:ATHENA_STARTMENU_DIR } else { [Environment]::GetFolderPath("Programs") }
$Branch = if ($env:ATHENA_UPDATE_BRANCH) { $env:ATHENA_UPDATE_BRANCH } else { "release" }

function Write-Log([string]$Message) {
    Write-Host "==> $Message"
}

function Invoke-Fail([string]$Message) {
    Write-Error "Athena-Studying install failed: $Message"
}

function Test-CommandExists([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Join-PathEnvValues([string]$MachinePath, [string]$UserPath) {
    ($MachinePath, $UserPath | Where-Object { $_ }) -join ";"
}

function Update-SessionPath {
    # A winget install updates the Machine or User PATH value in the
    # registry (depending on install scope) but never touches this
    # already-running process's $env:Path - so on a fresh machine, the
    # command this script just installed stays invisible to the rest of
    # this script and it tells the user to open a new terminal and re-run.
    # Re-read both scopes and recombine, the same approach Chocolatey's
    # `refreshenv` uses, so one run of the installer gets all the way
    # through.
    $env:Path = Join-PathEnvValues `
        ([System.Environment]::GetEnvironmentVariable("Path", "Machine")) `
        ([System.Environment]::GetEnvironmentVariable("Path", "User"))
}

function Install-ViaWinget([string]$Id, [string]$FriendlyName) {
    Write-Log "Installing $FriendlyName via winget..."
    & winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Invoke-Fail "winget install of $FriendlyName failed - install it manually and re-run this installer."
    }
    Update-SessionPath
}

function Ensure-Git {
    if (Test-CommandExists "git") { return }
    Write-Log "git not found."
    if (Test-CommandExists "winget") {
        Install-ViaWinget "Git.Git" "git"
        if (-not (Test-CommandExists "git")) {
            Invoke-Fail "git was installed but isn't on PATH yet - open a new terminal and re-run this installer."
        }
    } else {
        Invoke-Fail "git is required. Install it from https://git-scm.com, then re-run this installer."
    }
}

function Ensure-Node {
    if (Test-CommandExists "node") {
        $major = [int]((& node -e "console.log(process.versions.node.split('.')[0])") | Select-Object -First 1)
        if ($major -ge $MinNodeMajor) { return }
        Write-Log "node $(& node -v) found, but Athena-Studying needs Node $MinNodeMajor or newer."
    } else {
        Write-Log "node not found."
    }
    if (Test-CommandExists "winget") {
        Install-ViaWinget "OpenJS.NodeJS.LTS" "Node"
        if (-not (Test-CommandExists "node")) {
            Invoke-Fail "node was installed but isn't on PATH yet - open a new terminal and re-run this installer."
        }
    } else {
        Invoke-Fail "Node $MinNodeMajor+ is required. Install it from https://nodejs.org, then re-run this installer."
    }
}

function Test-AthenaHealthy([string]$Url) {
    # Mirrors bootstrap.mjs's waitForHealth contract ({ok: true, ...} JSON) -
    # used here for a one-shot check, not a poll, so a relaunch shortcut can
    # tell "already running" from "not running" instantly rather than
    # waiting out a timeout.
    try {
        $response = Invoke-RestMethod -Uri $Url -TimeoutSec 2 -ErrorAction Stop
        return [bool]$response.ok
    } catch {
        return $false
    }
}

function Open-AthenaBrowser([string]$Url) {
    # Same escape hatch as bootstrap.mjs's own ATHENA_NO_OPEN_BROWSER, and
    # for the same reason: a headless box (or a test) shouldn't have this
    # pop a real browser window.
    if ($env:ATHENA_NO_OPEN_BROWSER) { return }
    Start-Process $Url
}

function New-RelaunchShortcut([string]$Path, [string]$TargetPath, [string]$Arguments, [string]$WorkingDirectory) {
    $wshShell = New-Object -ComObject WScript.Shell
    $shortcut = $wshShell.CreateShortcut($Path)
    $shortcut.TargetPath = $TargetPath
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.WindowStyle = 7 # minimized; -WindowStyle Hidden in $Arguments does the real hiding
    $shortcut.Description = "Reopen Athena-Studying"
    $shortcut.Save()
}

function Install-RelaunchShortcuts {
    # Best-effort only, same philosophy as bootstrap.mjs's openBrowser: a
    # shortcut is a convenience, not core functionality, and WScript.Shell
    # (COM) could plausibly be blocked by some security policy on a given
    # machine - that must never take down an otherwise-successful install.
    try {
        # -ExecutionPolicy Bypass is a per-process override, not a system
        # setting change - it lets this one invocation run under the
        # default Restricted policy every fresh Windows machine ships
        # with, without touching the user's actual execution-policy
        # configuration.
        $powershellExe = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
        if (-not $powershellExe) {
            # Plain string concatenation, not Join-Path: Join-Path resolves
            # its base through the filesystem provider even just to build a
            # string, and a literal "C:\..." fallback has no such drive on
            # a non-Windows test host, which blows up here with "Cannot
            # find drive" long before this would ever run for real on
            # Windows.
            $systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
            $powershellExe = "$systemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        }
        $scriptPath = Join-Path (Join-Path $InstallDir "installers") "windows.ps1"
        $arguments = "-NoLogo -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
        foreach ($dir in @($DesktopDir, $StartMenuDir)) {
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            New-RelaunchShortcut -Path (Join-Path $dir "Athena-Studying.lnk") -TargetPath $powershellExe -Arguments $arguments -WorkingDirectory $InstallDir
        }
    } catch {
        Write-Log "Couldn't create a relaunch shortcut ($($_.Exception.Message)) - Athena-Studying will still work, just without one."
    }
}

function Sync-Checkout {
    if (Test-Path (Join-Path $InstallDir ".git")) {
        Write-Log "Found an existing checkout at $InstallDir, updating..."
        & git -C $InstallDir fetch --tags origin $Branch
        if ($LASTEXITCODE -ne 0) { Invoke-Fail "git fetch failed in $InstallDir." }
        & git -C $InstallDir show-ref --verify --quiet "refs/heads/$Branch"
        if ($LASTEXITCODE -eq 0) {
            & git -C $InstallDir checkout $Branch
            if ($LASTEXITCODE -ne 0) { Invoke-Fail "git checkout $Branch failed in $InstallDir." }
        } else {
            # A checkout from before the release channel existed (or before
            # this branch was ever fetched here) has no local branch to
            # switch to yet - create one tracking origin/$Branch so it
            # switches cleanly instead of failing. Covers e.g. an old
            # install still on `main` the first time it updates after
            # `release` became the tracked branch.
            & git -C $InstallDir checkout -b $Branch "origin/$Branch"
            if ($LASTEXITCODE -ne 0) { Invoke-Fail "git checkout -b $Branch failed in $InstallDir." }
        }
        & git -C $InstallDir merge --ff-only "origin/$Branch"
        if ($LASTEXITCODE -ne 0) { Invoke-Fail "$InstallDir has local changes that aren't a fast-forward of origin/$Branch - resolve manually, then re-run." }
    } else {
        Write-Log "Cloning Athena-Studying into $InstallDir..."
        & git clone --branch $Branch $RepoUrl $InstallDir
        if ($LASTEXITCODE -ne 0) { Invoke-Fail "git clone failed." }
    }
}

function Main {
    $healthUrl = "http://127.0.0.1:$Port/api/health"
    $appUrl = "http://127.0.0.1:$Port/"

    # Relaunching (via the shortcut Install-RelaunchShortcuts below creates)
    # must be harmless if Athena is already running - e.g. the friend
    # double-clicks the shortcut while a session is already open. Checked
    # first, before anything else in this script, so that case never waits
    # on a git fetch or an npm install it doesn't need.
    if (Test-AthenaHealthy $healthUrl) {
        Write-Log "Athena-Studying is already running."
        Open-AthenaBrowser $appUrl
        return
    }

    Ensure-Git
    Ensure-Node
    Sync-Checkout
    Install-RelaunchShortcuts
    Write-Log "Handing off to the Node installer..."
    # Chained two-arg Join-Path, not the 3-arg form: Windows PowerShell 5.1
    # (the default on Windows 10/11) has no -AdditionalChildPath parameter;
    # that was added in PowerShell 6+.
    & node (Join-Path (Join-Path $InstallDir "installers") "bootstrap.mjs")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not $env:ATHENA_TEST_SKIP_MAIN) {
    Main
}
