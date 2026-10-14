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
# scripts/promote-release.mjs).

set -euo pipefail

REPO_URL="${ATHENA_REPO_URL:-https://github.com/Elca10/Athena.git}"
INSTALL_DIR="${ATHENA_INSTALL_DIR:-$HOME/Athena-Studying}"
BRANCH="${ATHENA_UPDATE_BRANCH:-release}"
MIN_NODE_MAJOR=18
PORT="${ATHENA_PORT:-4417}"
APP_URL="http://127.0.0.1:$PORT/"

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
    git -C "$INSTALL_DIR" fetch origin "$BRANCH" || fail "git fetch failed in $INSTALL_DIR."
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

main() {
  if already_running; then
    log "Athena-Studying is already running: $APP_URL"
    log "To update it, stop it first, then run this command again. To stop it:"
    log "  lsof -ti tcp:$PORT -sTCP:LISTEN | xargs kill    (or just restart your Mac)"
    if [ -z "${ATHENA_NO_OPEN_BROWSER:-}" ] && have open; then open "$APP_URL" || true; fi
    exit 0
  fi
  ensure_git
  ensure_node
  clone_or_update
  log "Handing off to the Node installer..."
  node "$INSTALL_DIR/installers/bootstrap.mjs"
}

main
