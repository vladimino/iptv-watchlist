#!/bin/bash
# SessionStart hook for Claude Code cloud sessions.
# The test suite shells out to the sqlite3 CLI (tests/canonical-repository.mjs, tests/d1-schema.mjs,
# tests/epg-repository.mjs); GitHub Actions' ubuntu runner ships it, the cloud container does not.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  # The managed container runs as root; a self-hosted or custom image may not.
  SUDO=""
  if [ "$(id -u)" -ne 0 ]; then SUDO="sudo -n"; fi
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends sqlite3
fi

cd "$CLAUDE_PROJECT_DIR"
npm install --ignore-scripts --no-audit --no-fund
