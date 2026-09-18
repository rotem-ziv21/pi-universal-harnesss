#!/usr/bin/env bash
#
# Pi Universal Harness — portable installer (§50)
#
# Works unchanged on macOS, Linux, RunPod and cloud VMs. It discovers everything it
# needs at runtime and hardcodes no path belonging to any particular machine.
#
#   ./scripts/install.sh              install (symlink, recommended)
#   ./scripts/install.sh --copy       install by copying instead of symlinking
#   ./scripts/install.sh --dry-run    show what would happen, change nothing
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_NAME="pi-universal-harness"
MIN_PI_MINOR=85

MODE="symlink"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --copy)    MODE="copy" ;;
    --symlink) MODE="symlink" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- output helpers -----------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
ok()   { printf '    %sok%s   %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '    %swarn%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '    %sfail%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then printf '    would: %s\n' "$*"; else "$@"; fi; }

# --- 1. detect the OS ---------------------------------------------------------

step "Detecting the environment"

UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Darwin) OS="macOS" ;;
  Linux)  OS="Linux" ;;
  *)      OS="$UNAME_S"; warn "Untested platform: $UNAME_S. Continuing." ;;
esac
ok "$OS $(uname -m)"

# --- 2. verify Node -----------------------------------------------------------

command -v node >/dev/null 2>&1 || die "Node is not installed. Pi requires Node >= 22.19.0."

NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"

if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  die "Node $NODE_VERSION is too old. Pi requires >= 22.19.0."
fi
ok "Node $NODE_VERSION"

# --- 3. verify Pi and read its version ---------------------------------------

step "Locating Pi"

command -v pi >/dev/null 2>&1 || die "Pi is not on PATH. Install it first: npm install -g @earendil-works/pi-coding-agent"

PI_BIN="$(command -v pi)"
ok "pi at $PI_BIN"

# Resolve the package directory by following the bin symlink to its real location.
resolve_link() {
  local target="$1"
  while [ -L "$target" ]; do
    local link; link="$(readlink "$target")"
    case "$link" in
      /*) target="$link" ;;
      *)  target="$(cd "$(dirname "$target")" && cd "$(dirname "$link")" && pwd)/$(basename "$link")" ;;
    esac
  done
  printf '%s' "$target"
}

PI_REAL="$(resolve_link "$PI_BIN")"
PI_PKG_DIR=""
candidate="$(dirname "$PI_REAL")"
for _ in 1 2 3 4 5 6; do
  if [ -f "$candidate/package.json" ] && grep -q '"@earendil-works/pi-coding-agent"' "$candidate/package.json" 2>/dev/null; then
    PI_PKG_DIR="$candidate"; break
  fi
  parent="$(dirname "$candidate")"
  [ "$parent" = "$candidate" ] && break
  candidate="$parent"
done

PI_VERSION="$(pi --version 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
[ -n "$PI_VERSION" ] || die "Could not determine the Pi version (\`pi --version\` produced nothing)."
ok "Pi $PI_VERSION"

PI_MAJOR="${PI_VERSION%%.*}"
PI_REST="${PI_VERSION#*.}"
PI_MINOR="${PI_REST%%.*}"

if [ "$PI_MAJOR" -ne 0 ] || [ "$PI_MINOR" -lt "$MIN_PI_MINOR" ]; then
  warn "This harness was built against the Pi 0.${MIN_PI_MINOR}.x extension API; you have $PI_VERSION."
  warn "It may still work, but hook names and signatures should be re-checked against docs/extensions.md."
fi

# --- 4. determine the global extension directory ------------------------------
#
# The directory name comes from the installed package's piConfig.configDir — it is
# NOT assumed to be ".pi", because rebranded distributions use something else and the
# Pi docs explicitly warn against hardcoding it.
#
# The agent directory is then resolved exactly the way Pi resolves it (verified in
# Pi 0.85.1 dist/config.js): homedir()/<name>/agent, overridden by PI_CODING_AGENT_DIR.
# Pi honours NEITHER XDG_CONFIG_HOME NOR PI_CONFIG_DIR. Consulting those would install
# the extension into a directory Pi never reads — it would appear to succeed and then
# silently never load.

step "Resolving the Pi configuration directory"

CONFIG_DIR_NAME=".pi"
if [ -n "$PI_PKG_DIR" ] && [ -f "$PI_PKG_DIR/package.json" ]; then
  DISCOVERED="$(node -e '
    try {
      const pkg = require(process.argv[1] + "/package.json");
      process.stdout.write(pkg?.piConfig?.configDir || "");
    } catch { process.stdout.write(""); }
  ' "$PI_PKG_DIR" 2>/dev/null || true)"
  [ -n "$DISCOVERED" ] && CONFIG_DIR_NAME="$DISCOVERED"
fi
ok "config directory name: $CONFIG_DIR_NAME"

if [ -n "${PI_HARNESS_CONFIG_DIR:-}" ]; then
  AGENT_DIR="$PI_HARNESS_CONFIG_DIR/agent"
elif [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  AGENT_DIR="$PI_CODING_AGENT_DIR"
else
  [ -n "${HOME:-}" ] || die "HOME is not set and no override was given. Set PI_HARNESS_CONFIG_DIR."
  AGENT_DIR="$HOME/$CONFIG_DIR_NAME/agent"
fi

CONFIG_DIR="$(dirname "$AGENT_DIR")"
EXTENSIONS_DIR="$AGENT_DIR/extensions"
HARNESS_STATE_DIR="${PI_HARNESS_HOME:-$AGENT_DIR/harness}"
TARGET="$EXTENSIONS_DIR/$EXTENSION_NAME"

ok "extensions: $EXTENSIONS_DIR"
ok "state:      $HARNESS_STATE_DIR"

# --- 5. dependencies ----------------------------------------------------------

step "Checking dependencies"

# The harness imports only Node built-ins plus `typebox`, which ships inside Pi and is
# one of the imports Pi guarantees to extensions. There is nothing to install and no
# build step — Pi loads TypeScript directly through jiti.
if [ -n "$PI_PKG_DIR" ] && [ -d "$PI_PKG_DIR/node_modules/typebox" ]; then
  ok "typebox provided by Pi; no dependencies to install"
else
  warn "Could not confirm typebox inside the Pi installation. If the harness fails to load, run: npm install typebox --prefix \"$REPO_DIR\""
fi

# --- 6. install ---------------------------------------------------------------

step "Installing the harness"

[ -f "$REPO_DIR/index.ts" ] || die "index.ts is missing from $REPO_DIR — is this the harness repository?"

run mkdir -p "$EXTENSIONS_DIR"

# Preserve anything already there that is not ours (§50.8, §50.9).
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if [ -L "$TARGET" ]; then
    EXISTING="$(readlink "$TARGET")"
    if [ "$EXISTING" = "$REPO_DIR" ]; then
      ok "already linked to this checkout; nothing to do"
    else
      warn "replacing a symlink that pointed at $EXISTING"
      run rm -f "$TARGET"
    fi
  else
    BACKUP="$TARGET.backup.$(date +%Y%m%d%H%M%S)"
    warn "an existing directory is in the way; moving it to $(basename "$BACKUP")"
    run mv "$TARGET" "$BACKUP"
  fi
fi

if [ ! -e "$TARGET" ]; then
  if [ "$MODE" = "symlink" ]; then
    run ln -s "$REPO_DIR" "$TARGET"
    ok "symlinked $TARGET -> $REPO_DIR"
  else
    run mkdir -p "$TARGET"
    run cp -R "$REPO_DIR/index.ts" "$REPO_DIR/src" "$REPO_DIR/package.json" "$TARGET/"
    ok "copied the harness into $TARGET"
  fi
fi

# --- 7. state directories -----------------------------------------------------

step "Creating the state directory"
run mkdir -p "$HARNESS_STATE_DIR/tasks"
if [ "$DRY_RUN" -eq 0 ]; then chmod 700 "$HARNESS_STATE_DIR" 2>/dev/null || true; fi
ok "$HARNESS_STATE_DIR (mode 700)"

# Never overwrite an existing config (§50.8).
CONFIG_FILE="$HARNESS_STATE_DIR/config.json"
if [ -f "$CONFIG_FILE" ]; then
  ok "existing config preserved: $CONFIG_FILE"
else
  if [ "$DRY_RUN" -eq 0 ]; then
    cat > "$CONFIG_FILE" <<'JSON'
{
  "enabled": true,
  "judge": {
    "enabled": true,
    "provider": "openrouter",
    "baseUrl": "https://openrouter.ai/api",
    "decisionsPath": "/alpha/decisions",
    "model": "~typesafe/jev-latest"
  }
}
JSON
    chmod 600 "$CONFIG_FILE" 2>/dev/null || true
  fi
  ok "wrote a default config (no secrets) to $CONFIG_FILE"
fi

# --- 8. verify ----------------------------------------------------------------

step "Verifying the installation"

if [ "$DRY_RUN" -eq 1 ]; then
  ok "dry run: skipping verification"
else
  [ -e "$TARGET/index.ts" ] || die "$TARGET/index.ts is not readable — the install did not take."
  ok "entry point resolves"

  if node --experimental-strip-types --input-type=module -e "
    import { readFileSync } from 'node:fs';
    const src = readFileSync(process.argv[1] + '/index.ts', 'utf8');
    if (!src.includes('export default')) { console.error('no default export'); process.exit(1); }
  " "$TARGET" 2>/dev/null; then
    ok "extension exports a default factory"
  else
    warn "could not statically verify the entry point; Pi will report any load error on startup"
  fi
fi

# --- 9. next steps ------------------------------------------------------------

printf '\n%sInstalled.%s\n\n' "$BOLD" "$RESET"
echo "Next steps:"
echo
echo "  1. Give the Judge an API key (machine-local; it never goes into git):"
echo
echo "       export OPENROUTER_API_KEY=\"sk-or-v1-…\"      # add to your shell profile"
echo "     or, inside Pi:"
echo "       /harness setup"
echo
echo "  2. Start Pi and confirm everything is healthy:"
echo
echo "       pi"
echo "       /harness doctor"
echo
if [ "$MODE" = "symlink" ]; then
  echo "  To update later:"
  echo
  echo "       cd $REPO_DIR && git pull"
  echo "       # then /reload inside Pi"
  echo
fi
