#!/usr/bin/env bash
#
# Pi Universal Harness — uninstaller (§51)
#
# Removes ONLY what the harness installed. It will not touch Pi, other extensions,
# project files, or any configuration it did not create.
#
# Persisted task history is kept unless you explicitly ask for it to be deleted.
#
#   ./scripts/uninstall.sh                remove the extension, keep all history
#   ./scripts/uninstall.sh --purge-state  also delete config, secrets and history
#   ./scripts/uninstall.sh --dry-run      show what would happen
#
set -euo pipefail

EXTENSION_NAME="pi-universal-harness"
PURGE=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --purge-state) PURGE=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  BOLD=$'\033[1m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'; RESET=$'\033[0m'
else
  BOLD=""; YELLOW=""; GREEN=""; RESET=""
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
ok()   { printf '    %sok%s   %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '    %swarn%s %s\n' "$YELLOW" "$RESET" "$1"; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then printf '    would: %s\n' "$*"; else "$@"; fi; }

# Resolve paths exactly as the installer does.
CONFIG_DIR_NAME="${PI_CONFIG_DIR_NAME:-.pi}"
if [ -n "${PI_HARNESS_CONFIG_DIR:-}" ]; then
  CONFIG_DIR="$PI_HARNESS_CONFIG_DIR"
elif [ -n "${PI_CONFIG_DIR:-}" ]; then
  CONFIG_DIR="$PI_CONFIG_DIR"
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  CONFIG_DIR="$XDG_CONFIG_HOME/$CONFIG_DIR_NAME"
else
  CONFIG_DIR="$HOME/$CONFIG_DIR_NAME"
fi

EXTENSIONS_DIR="$CONFIG_DIR/agent/extensions"
TARGET="$EXTENSIONS_DIR/$EXTENSION_NAME"
HARNESS_STATE_DIR="${PI_HARNESS_HOME:-$CONFIG_DIR/agent/harness}"

step "Removing the harness extension"

if [ -L "$TARGET" ]; then
  # A symlink: removing it cannot affect the git checkout it points at.
  run rm -f "$TARGET"
  ok "removed the symlink at $TARGET"
elif [ -d "$TARGET" ]; then
  # Only remove a directory we can confirm is ours.
  if [ -f "$TARGET/index.ts" ] && grep -q "Pi Universal Harness" "$TARGET/index.ts" 2>/dev/null; then
    run rm -rf "$TARGET"
    ok "removed the copied installation at $TARGET"
  else
    warn "$TARGET exists but does not look like this harness. Leaving it alone."
  fi
else
  ok "no installed extension found; nothing to remove"
fi

step "Harness state"

if [ ! -d "$HARNESS_STATE_DIR" ]; then
  ok "no state directory at $HARNESS_STATE_DIR"
elif [ "$PURGE" -eq 1 ]; then
  echo
  echo "  This will permanently delete:"
  echo "    - every Task Contract and its audit log"
  echo "    - the harness configuration"
  echo "    - the locally stored OpenRouter API key"
  echo
  echo "  Location: $HARNESS_STATE_DIR"
  echo
  printf "  Type 'delete' to confirm: "
  read -r CONFIRM
  if [ "$CONFIRM" = "delete" ]; then
    run rm -rf "$HARNESS_STATE_DIR"
    ok "state deleted"
  else
    warn "not confirmed; state kept"
  fi
else
  TASK_COUNT=$(find "$HARNESS_STATE_DIR/tasks" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  ok "kept $HARNESS_STATE_DIR ($TASK_COUNT task record(s))"
  echo "         Run with --purge-state to delete it, including the stored API key."
fi

printf '\n%sUninstalled.%s Pi, your other extensions and your projects were not modified.\n' "$BOLD" "$RESET"
