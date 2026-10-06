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
# Overridable via env for testing: ATHENA_REPO_URL, ATHENA_INSTALL_DIR.

set -euo pipefail

REPO_URL="${ATHENA_REPO_URL:-https://github.com/Elca10/Athena.git}"
INSTALL_DIR="${ATHENA_INSTALL_DIR:-$HOME/Athena-Studying}"
MIN_NODE_MAJOR=18

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

clone_or_update() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "Found an existing checkout at $INSTALL_DIR, updating..."
    git -C "$INSTALL_DIR" fetch origin main || fail "git fetch failed in $INSTALL_DIR."
    git -C "$INSTALL_DIR" checkout main || fail "git checkout main failed in $INSTALL_DIR."
    git -C "$INSTALL_DIR" merge --ff-only origin/main \
      || fail "$INSTALL_DIR has local changes that aren't a fast-forward of origin/main — resolve manually, then re-run."
  else
    log "Cloning Athena-Studying into $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR" || fail "git clone failed."
  fi
}

main() {
  ensure_git
  ensure_node
  clone_or_update
  log "Handing off to the Node installer..."
  node "$INSTALL_DIR/installers/bootstrap.mjs"
}

main
