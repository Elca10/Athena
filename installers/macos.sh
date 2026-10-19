#!/usr/bin/env bash
# One-command installer for Athena-Studying on macOS (SPEC.md section 2).
#
#   curl -fsSL <raw-url-to-this-file> | sh
#
# Scope kept deliberately small: this script only solves the
# chicken-and-egg problem of getting git + Node + a checkout onto a
# machine that may have neither yet. Everything else (checking claude/gh,
# installing npm deps, starting the server) is cross-platform Node code in
# installers/bootstrap.mjs — shared with the future Windows installer, and
# unit-testable the normal way, unlike this file.
#
# Overridable via env for testing: ATHENA_REPO_URL, ATHENA_INSTALL_DIR,
# ATHENA_PORT (must match the port the server binds), ATHENA_NO_OPEN_BROWSER,
# ATHENA_UPDATE_BRANCH (which branch installs track and auto-update from —
# defaults to `release` so nothing pushed straight to `main` reaches an
# installed copy until the maintainer promotes it; see
# scripts/promote-release.mjs), ATHENA_APPLICATIONS_DIR (where the relaunch
# app goes — so a test never touches the real ~/Applications; setting it
# also makes the app get written on a non-macOS test host).
#
# Also writes an Athena-Studying.app into ~/Applications (Launchpad,
# Spotlight, draggable to the Dock) that re-runs this same script from the
# checkout, so a relaunch gets the same update + rollback path as a fresh
# install, or just opens the browser when Athena is already running — the
# macOS twin of windows.ps1's relaunch shortcut (SPEC-v2.md section 7).

set -euo pipefail

REPO_URL="${ATHENA_REPO_URL:-https://github.com/Elca10/Athena.git}"
INSTALL_DIR="${ATHENA_INSTALL_DIR:-$HOME/Athena-Studying}"
BRANCH="${ATHENA_UPDATE_BRANCH:-release}"
MIN_NODE_MAJOR=18
PORT="${ATHENA_PORT:-4417}"
APP_URL="http://127.0.0.1:$PORT/"
APP_NAME="Athena-Studying"
APPLICATIONS_DIR="${ATHENA_APPLICATIONS_DIR:-$HOME/Applications}"

log() { printf '==> %s\n' "$1"; }
fail() { printf 'Athena-Studying install failed: %s\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

ensure_git() {
  if have git; then return; fi
  log "git not found."
  if have brew; then
    log "Installing git via Homebrew..."
    brew install git || fail "Homebrew install of git failed — install git manually (https://git-scm.com) and re-run this installer."
  else
    fail "git is required. Install Homebrew (https://brew.sh) or the Xcode Command Line Tools (xcode-select --install), then re-run this installer."
  fi
}

ensure_node() {
  if have node; then
    local major
    major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
    if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
      return
    fi
    log "node $(node -v) found, but Athena-Studying needs Node $MIN_NODE_MAJOR or newer."
  else
    log "node not found."
  fi
  if have brew; then
    log "Installing Node via Homebrew..."
    brew install node || fail "Homebrew install of node failed — install Node $MIN_NODE_MAJOR+ manually (https://nodejs.org) and re-run this installer."
  else
    fail "Node $MIN_NODE_MAJOR+ is required. Install Homebrew (https://brew.sh) or Node directly (https://nodejs.org), then re-run this installer."
  fi
}

# One-shot health check, same contract as windows.ps1's Test-AthenaHealthy.
# Re-running this command while a server is already up must not update the
# checkout or run npm install underneath it: the old process keeps serving,
# the new one can't bind the port, and the health check then passes against
# the OLD server, leaving it running against changed files on disk
# (issue #4). No curl means we can't tell, so carry on as a fresh start.
already_running() {
  have curl || return 1
  curl -fsS --max-time 2 "${APP_URL}api/health" 2>/dev/null | grep -q '"ok":true'
}

clone_or_update() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "Found an existing checkout at $INSTALL_DIR, updating..."
    git -C "$INSTALL_DIR" fetch --tags origin "$BRANCH" || fail "git fetch failed in $INSTALL_DIR."
    if git -C "$INSTALL_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git -C "$INSTALL_DIR" checkout "$BRANCH" || fail "git checkout $BRANCH failed in $INSTALL_DIR."
    else
      # A checkout from before the release channel existed (or before this
      # branch was ever fetched here) has no local branch to switch to yet —
      # create one tracking origin/$BRANCH so it switches cleanly instead of
      # failing. Covers e.g. an old install still on `main` the first time it
      # updates after `release` became the tracked branch.
      git -C "$INSTALL_DIR" checkout -b "$BRANCH" "origin/$BRANCH" \
        || fail "git checkout -b $BRANCH failed in $INSTALL_DIR."
    fi
    git -C "$INSTALL_DIR" merge --ff-only "origin/$BRANCH" \
      || fail "$INSTALL_DIR has local changes that aren't a fast-forward of origin/$BRANCH — resolve manually, then re-run."
  else
    log "Cloning Athena-Studying into $INSTALL_DIR..."
    git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" || fail "git clone failed."
  fi
}

# The app's executable. Finder launches apps with a bare PATH
# (/usr/bin:/bin:/usr/sbin:/sbin), which has none of Homebrew's node/gh or
# Claude Code's claude — so it bakes in the PATH this install ran with
# (the terminal where the README had the user check all three), and the
# server it starts inherits it. Output goes to a log file because there's
# no terminal to show it, and a failure gets a dialog instead of silence.
app_launcher_source() {
  printf '#!/bin/bash\n'
  printf '# Written by %s/installers/macos.sh; re-running the installer rewrites it.\n' "$INSTALL_DIR"
  printf 'export PATH=%q\n' "$PATH"
  printf 'export ATHENA_INSTALL_DIR=%q\n' "$INSTALL_DIR"
  printf 'export ATHENA_REPO_URL=%q\n' "$REPO_URL"
  printf 'export ATHENA_UPDATE_BRANCH=%q\n' "$BRANCH"
  printf 'export ATHENA_PORT=%q\n' "$PORT"
  printf 'export ATHENA_APPLICATIONS_DIR=%q\n' "$APPLICATIONS_DIR"
  cat <<'EOF'
log_dir="$HOME/Library/Logs/Athena-Studying"
mkdir -p "$log_dir"
if ! /bin/bash "$ATHENA_INSTALL_DIR/installers/macos.sh" >"$log_dir/launcher.log" 2>&1; then
  osascript -e 'on run argv' -e 'display alert (item 1 of argv) message (item 2 of argv) as critical' -e 'end run' \
    "Athena-Studying couldn't start" \
    "Try opening it again. If it still fails, run the install command from the README in Terminal to see what's wrong. Details: $log_dir/launcher.log" \
    >/dev/null 2>&1
  exit 1
fi
EOF
}

app_info_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>io.github.elca10.athena-studying</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
</dict>
</plist>
EOF
}

# Best-effort, like windows.ps1's Install-RelaunchShortcuts: an app is a
# convenience, so failing to write one must never fail the install. Built
# in a temp dir and swapped in whole, and skipped when nothing changed —
# the usual case when the app itself is what's running this script.
install_relaunch_app() {
  [[ "${OSTYPE:-}" == darwin* || -n "${ATHENA_APPLICATIONS_DIR:-}" ]] || return 0
  [ -f "$INSTALL_DIR/installers/macos.sh" ] || return 0
  local app="$APPLICATIONS_DIR/$APP_NAME.app"
  local tmp="$APPLICATIONS_DIR/.$APP_NAME.app.tmp.$$"
  local exe="Contents/MacOS/$APP_NAME"
  if ! {
    rm -rf "$tmp" \
      && mkdir -p "$tmp/Contents/MacOS" \
      && app_info_plist >"$tmp/Contents/Info.plist" \
      && app_launcher_source >"$tmp/$exe" \
      && chmod 755 "$tmp/$exe"
  } 2>/dev/null; then
    rm -rf "$tmp" 2>/dev/null || true
    log "Couldn't create the $APP_NAME app in $APPLICATIONS_DIR. Athena-Studying still works; reopen it by running this install command again."
    return 0
  fi
  if cmp -s "$tmp/$exe" "$app/$exe" 2>/dev/null && cmp -s "$tmp/Contents/Info.plist" "$app/Contents/Info.plist" 2>/dev/null; then
    rm -rf "$tmp" 2>/dev/null || true
    return 0
  fi
  if rm -rf "$app" 2>/dev/null && mv "$tmp" "$app" 2>/dev/null; then
    log "Added $APP_NAME to $APPLICATIONS_DIR. Next time, open it from Launchpad or Spotlight (or drag it to your Dock)."
  else
    rm -rf "$tmp" 2>/dev/null || true
    log "Couldn't create the $APP_NAME app in $APPLICATIONS_DIR. Athena-Studying still works; reopen it by running this install command again."
  fi
}

main() {
  if already_running; then
    log "Athena-Studying is already running: $APP_URL"
    log "To update it, stop it first, then run this command again. To stop it:"
    log "  lsof -ti tcp:$PORT -sTCP:LISTEN | xargs kill    (or just restart your Mac)"
    # Doesn't touch the checkout, so it's safe under a live server — and
    # it's how an install from before the app existed gets one.
    install_relaunch_app
    if [ -z "${ATHENA_NO_OPEN_BROWSER:-}" ] && have open; then open "$APP_URL" || true; fi
    exit 0
  fi
  ensure_git
  ensure_node
  clone_or_update
  install_relaunch_app
  log "Handing off to the Node installer..."
  node "$INSTALL_DIR/installers/bootstrap.mjs"
}

# On one line so bash has read all of it before running: when the app runs
# this file from the checkout, the update in clone_or_update can replace
# it on disk mid-run.
main "$@"; exit $?
