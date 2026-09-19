#!/usr/bin/env bash
#
# Pi Universal Harness — standalone doctor (§52)
#
# The same diagnosis as `/harness doctor`, runnable from a shell without starting Pi.
# Useful in CI, in a fresh container, and when Pi itself will not start.
#
#   ./scripts/doctor.sh
#
set -uo pipefail

EXTENSION_NAME="pi-universal-harness"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

FAILURES=0
WARNINGS=0

pass() { printf '%sPASS%s %s\n     %s\n' "$GREEN" "$RESET" "$1" "$2"; }
warn() { printf '%sWARN%s %s\n     %s\n' "$YELLOW" "$RESET" "$1" "$2"; WARNINGS=$((WARNINGS+1)); }
fail() { printf '%sFAIL%s %s\n     %s\n' "$RED" "$RESET" "$1" "$2"; FAILURES=$((FAILURES+1)); }
fix()  { printf '     → %s\n' "$1"; }

printf '%sHarness doctor%s\n\n' "$BOLD" "$RESET"

# --- Node ---------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version | sed 's/^v//')"
  NODE_MAJOR="${NODE_VERSION%%.*}"; NODE_REST="${NODE_VERSION#*.}"; NODE_MINOR="${NODE_REST%%.*}"
  if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 19 ]; }; then
    pass "Node runtime" "Node $NODE_VERSION on $(uname -s)/$(uname -m)"
  else
    fail "Node runtime" "Node $NODE_VERSION is below the required 22.19.0"
    fix "Upgrade Node to 22.19.0 or newer."
  fi
else
  fail "Node runtime" "Node is not installed"
  fix "Install Node >= 22.19.0."
fi

# --- Pi -----------------------------------------------------------------------
if command -v pi >/dev/null 2>&1; then
  PI_VERSION="$(pi --version 2>/dev/null | head -1 | tr -d '[:space:]')"
  if [ -n "$PI_VERSION" ]; then
    PI_MAJOR="${PI_VERSION%%.*}"; PI_REST="${PI_VERSION#*.}"; PI_MINOR="${PI_REST%%.*}"
    if [ "$PI_MAJOR" -eq 0 ] && [ "$PI_MINOR" -ge 85 ]; then
      pass "Pi installation" "Pi $PI_VERSION at $(command -v pi)"
    else
      warn "Pi installation" "Pi $PI_VERSION; this harness targets the 0.85.x extension API"
      fix "Hooks and signatures should be re-checked against the installed docs/extensions.md."
    fi
  else
    warn "Pi installation" "pi is on PATH but did not report a version"
  fi
else
  fail "Pi installation" "Pi is not on PATH"
  fix "npm install -g @earendil-works/pi-coding-agent"
fi

# --- paths --------------------------------------------------------------------
# Resolved exactly as Pi resolves it (see install.sh).
CONFIG_DIR_NAME="${PI_CONFIG_DIR_NAME:-.pi}"
if [ -n "${PI_HARNESS_CONFIG_DIR:-}" ]; then AGENT_DIR="$PI_HARNESS_CONFIG_DIR/agent"
elif [ -n "${PI_CODING_AGENT_DIR:-}" ]; then AGENT_DIR="$PI_CODING_AGENT_DIR"
else                                          AGENT_DIR="$HOME/$CONFIG_DIR_NAME/agent"; fi

CONFIG_DIR="$(dirname "$AGENT_DIR")"
EXTENSIONS_DIR="$AGENT_DIR/extensions"
TARGET="$EXTENSIONS_DIR/$EXTENSION_NAME"
HARNESS_STATE_DIR="${PI_HARNESS_HOME:-$AGENT_DIR/harness}"

if [ -e "$TARGET" ]; then
  if [ -L "$TARGET" ]; then
    pass "Extension installed" "symlink -> $(readlink "$TARGET")"
  else
    pass "Extension installed" "copied installation at $TARGET"
  fi
else
  warn "Extension installed" "not found at $TARGET"
  fix "Run ./scripts/install.sh  (or use 'pi -e $REPO_DIR/index.ts' for a one-off run)."
fi

if [ -d "$HARNESS_STATE_DIR" ] && [ -w "$HARNESS_STATE_DIR" ]; then
  TASKS=$(find "$HARNESS_STATE_DIR/tasks" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  pass "State directory" "$HARNESS_STATE_DIR is writable ($TASKS task record(s))"
elif [ -d "$HARNESS_STATE_DIR" ]; then
  fail "State directory" "$HARNESS_STATE_DIR is not writable"
  fix "chmod u+rwx \"$HARNESS_STATE_DIR\""
else
  warn "State directory" "$HARNESS_STATE_DIR does not exist yet"
  fix "It is created by ./scripts/install.sh, or on the harness's first run."
fi

# --- does state survive a restart? --------------------------------------------
#
# In a container, anything on the root overlay is destroyed when the container is
# recreated; only mounted volumes survive. Harness state on the overlay silently
# loses every task contract, the audit log and the stored key on the next restart,
# and nothing else here would hint at it: the directory is present and writable.
#
# Generic by construction — detect a container, then find the mount point the state
# directory falls under. No hosting provider is named or assumed.

if [ "$(uname -s)" = "Linux" ] && { [ -f /.dockerenv ] || [ -f /run/.containerenv ] || grep -qiE 'docker|containerd|kubepods|lxc|podman' /proc/1/cgroup 2>/dev/null; }; then
  STATE_MOUNT=""
  if [ -d "$HARNESS_STATE_DIR" ]; then
    STATE_MOUNT="$(df -P "$HARNESS_STATE_DIR" 2>/dev/null | awk 'NR==2 {print $6}')"
  else
    STATE_MOUNT="$(df -P "$(dirname "$HARNESS_STATE_DIR")" 2>/dev/null | awk 'NR==2 {print $6}')"
  fi

  if [ -z "$STATE_MOUNT" ]; then
    :
  elif [ "$STATE_MOUNT" = "/" ]; then
    warn "State survives a restart" "container detected, and state is on the root filesystem, not a mounted volume"
    fix "Task contracts, the audit log and any stored key will be lost when the container is recreated."
    fix "Before starting Pi:  export PI_CODING_AGENT_DIR=\"<volume>/.pi/agent\"  and  export PI_HARNESS_HOME=\"<volume>/.pi/agent/harness\""
    fix "Then re-run ./scripts/install.sh, and put those exports somewhere that runs on login."
  else
    pass "State survives a restart" "state is on a mounted volume ($STATE_MOUNT)"
  fi
fi

# --- secrets ------------------------------------------------------------------
SECRETS_FILE="$HARNESS_STATE_DIR/secrets.json"
KEY_SOURCE="none"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  KEY_SOURCE="env"
  pass "OpenRouter API key" "set in the environment (${OPENROUTER_API_KEY:0:5}…${OPENROUTER_API_KEY: -4})"
elif [ -f "$SECRETS_FILE" ]; then
  KEY_SOURCE="store"
  pass "OpenRouter API key" "present in the local secret store"
else
  fail "OpenRouter API key" "not configured"
  fix "export OPENROUTER_API_KEY=\"sk-or-v1-…\"  or run /harness setup inside Pi."
fi

if [ -f "$SECRETS_FILE" ]; then
  if [ "$(uname -s)" != "Darwin" ] && [ "$(uname -s)" != "Linux" ]; then
    pass "Secret store permissions" "POSIX modes do not apply on this platform"
  else
    MODE="$(stat -f '%OLp' "$SECRETS_FILE" 2>/dev/null || stat -c '%a' "$SECRETS_FILE" 2>/dev/null)"
    if [ "$MODE" = "600" ]; then
      pass "Secret store permissions" "mode $MODE"
    else
      fail "Secret store permissions" "mode $MODE — it must not be group- or world-readable"
      fix "chmod 600 \"$SECRETS_FILE\""
    fi
  fi
fi

# --- repository hygiene -------------------------------------------------------
if git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  TRACKED_SECRETS="$(git -C "$REPO_DIR" ls-files | grep -E '(^|/)(secrets\.json|\.env)$' || true)"
  if [ -n "$TRACKED_SECRETS" ]; then
    fail "No secrets in git" "these files are tracked: $TRACKED_SECRETS"
    fix "git rm --cached the file, add it to .gitignore, and rotate the key immediately."
  else
    pass "No secrets in git" "no secret files are tracked in this repository"
  fi
fi

case "$HARNESS_STATE_DIR" in
  "$REPO_DIR"*) fail "State outside the repository" "state lives inside the git checkout: $HARNESS_STATE_DIR"
                fix "Set PI_HARNESS_HOME to a path outside the repository." ;;
  *)            pass "State outside the repository" "state is outside the git checkout" ;;
esac

# --- Judge reachability -------------------------------------------------------
BASE_URL="https://openrouter.ai/api"
DECISIONS_PATH="/alpha/decisions"
MODEL="~typesafe/jev-latest"
CONFIG_FILE="$HARNESS_STATE_DIR/config.json"

if [ -f "$CONFIG_FILE" ] && command -v node >/dev/null 2>&1; then
  EVAL="$(node -e '
    try {
      const c = require(process.argv[1]);
      const j = c.judge || {};
      process.stdout.write([j.baseUrl||"", j.decisionsPath||"", j.model||""].join("\n"));
    } catch { process.stdout.write("\n\n"); }
  ' "$CONFIG_FILE" 2>/dev/null)"
  [ -n "$(echo "$EVAL" | sed -n 1p)" ] && BASE_URL="$(echo "$EVAL" | sed -n 1p)"
  [ -n "$(echo "$EVAL" | sed -n 2p)" ] && DECISIONS_PATH="$(echo "$EVAL" | sed -n 2p)"
  [ -n "$(echo "$EVAL" | sed -n 3p)" ] && MODEL="$(echo "$EVAL" | sed -n 3p)"
fi

ENDPOINT="${BASE_URL%/}$DECISIONS_PATH"

if [ "$KEY_SOURCE" = "env" ] && command -v curl >/dev/null 2>&1; then
  # A real decisions round trip. Jev is a decisions model, so hitting /v1/models
  # would prove nothing about whether the path we actually use works.
  RESPONSE="$(curl -s -m 20 -w '\n%{http_code}' -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" \
    -H "Content-Type: application/json" \
    -H "X-Title: Pi Universal Harness (doctor)" \
    -d "{\"model\":\"$MODEL\",\"state\":\"connectivity self-test\",\"questions\":{\"healthcheck\":{\"type\":\"noul\",\"instructions\":\"Is this a self-test message?\"}}}" 2>/dev/null)"
  STATUS="$(printf '%s' "$RESPONSE" | tail -1)"
  BODY="$(printf '%s' "$RESPONSE" | sed '$d')"

  case "$STATUS" in
    200)
      if printf '%s' "$BODY" | grep -q '"noul"'; then
        pass "Judge connectivity" "$MODEL answered via $ENDPOINT"
      else
        warn "Judge connectivity" "HTTP 200 but the answer was not in the expected shape"
        fix "Check https://docs.typesafe.ai/api and src/judges/openrouter-jev.ts."
      fi ;;
    401|403)
      fail "Judge connectivity" "OpenRouter rejected the key (HTTP $STATUS)"
      fix "Generate a new key at https://openrouter.ai/keys." ;;
    404)
      fail "Judge connectivity" "HTTP 404 from $ENDPOINT for model $MODEL"
      fix "OpenRouter serves Jev from an alpha path that may have moved. Update judge.decisionsPath in $CONFIG_FILE." ;;
    429)
      warn "Judge connectivity" "rate limited (HTTP 429)"
      fix "Retry shortly, or check your OpenRouter account limits." ;;
    "")
      fail "Judge connectivity" "no response from $ENDPOINT"
      fix "Check network access and proxy settings." ;;
    *)
      fail "Judge connectivity" "HTTP $STATUS from $ENDPOINT" ;;
  esac
elif [ "$KEY_SOURCE" = "store" ]; then
  warn "Judge connectivity" "the key is in the local store; this script does not read it"
  fix "Run /harness doctor inside Pi for a full connectivity check."
else
  warn "Judge connectivity" "skipped — no API key available to this shell"
fi

# --- summary ------------------------------------------------------------------
printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  printf '%s%d failure(s), %d warning(s).%s The harness will not work correctly until the failures are fixed.\n' "$BOLD" "$FAILURES" "$WARNINGS" "$RESET"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  printf '%sAll critical checks passed, with %d warning(s).%s\n' "$BOLD" "$WARNINGS" "$RESET"
  exit 0
else
  printf '%sAll checks passed.%s\n' "$BOLD" "$RESET"
  exit 0
fi
