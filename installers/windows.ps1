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
# Overridable via env for testing: ATHENA_REPO_URL, ATHENA_INSTALL_DIR.

# $PSStyle only exists on PowerShell 7.2+ (not the Windows PowerShell 5.1
# that ships by default on Windows 10/11) - guard it rather than assume it.
if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }
$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:ATHENA_REPO_URL) { $env:ATHENA_REPO_URL } else { "https://github.com/Elca10/Athena.git" }
$InstallDir = if ($env:ATHENA_INSTALL_DIR) { $env:ATHENA_INSTALL_DIR } else { Join-Path $HOME "Athena-Studying" }
$MinNodeMajor = 18

function Write-Log([string]$Message) {
    Write-Host "==> $Message"
}

function Invoke-Fail([string]$Message) {
    Write-Error "Athena-Studying install failed: $Message"
}

function Test-CommandExists([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-ViaWinget([string]$Id, [string]$FriendlyName) {
    Write-Log "Installing $FriendlyName via winget..."
    & winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Invoke-Fail "winget install of $FriendlyName failed - install it manually and re-run this installer."
    }
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

function Sync-Checkout {
    if (Test-Path (Join-Path $InstallDir ".git")) {
        Write-Log "Found an existing checkout at $InstallDir, updating..."
        & git -C $InstallDir fetch origin main
        if ($LASTEXITCODE -ne 0) { Invoke-Fail "git fetch failed in $InstallDir." }
        & git -C $InstallDir checkout main
        if ($LASTEXITCODE -ne 0) { Invoke-Fail "git checkout main failed in $InstallDir." }
        & git -C $InstallDir merge --ff-only origin/main
        if ($LASTEXITCODE -ne 0) { Invoke-Fail "$InstallDir has local changes that aren't a fast-forward of origin/main - resolve manually, then re-run." }
    } else {
        Write-Log "Cloning Athena-Studying into $InstallDir..."
        & git clone $RepoUrl $InstallDir
        if ($LASTEXITCODE -ne 0) { Invoke-Fail "git clone failed." }
    }
}

function Main {
    Ensure-Git
    Ensure-Node
    Sync-Checkout
    Write-Log "Handing off to the Node installer..."
    # Chained two-arg Join-Path, not the 3-arg form: Windows PowerShell 5.1
    # (the default on Windows 10/11) has no -AdditionalChildPath parameter;
    # that was added in PowerShell 6+.
    & node (Join-Path (Join-Path $InstallDir "installers") "bootstrap.mjs")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Main
