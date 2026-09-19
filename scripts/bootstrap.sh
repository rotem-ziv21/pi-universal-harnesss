#!/usr/bin/env bash
#
# Pi Universal Harness — one-line bootstrap
#
# Clones (or updates) the harness and installs it, in a single command. Intended for
# throwaway machines: containers, fresh pods, new VMs, CI.
#
#   curl -fsSL https://raw.githubusercontent.com/rotem-ziv21/pi-universal-harnesss/main/scripts/bootstrap.sh | bash
#
# Environment:
#   HARNESS_DIR   where to put the checkout. Default: the first writable persistent
#                 location found, else $HOME/pi-universal-harness.
#   HARNESS_REF   branch or tag to check out. Default: main.
#   HARNESS_REPO  clone URL, for forks.
#
# It is idempotent: run it as often as you like. An existing checkout is updated
# rather than re-cloned, and local changes are never discarded silently.
#
set -euo pipefail

REPO="${HARNESS_REPO:-https://github.com/rotem-ziv21/pi-universal-harnesss.git}"
REF="${HARNESS_REF:-main}"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
ok()   { printf '    %sok%s   %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '    %swarn%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '    %sfail%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# --- prerequisites ------------------------------------------------------------

command -v git  >/dev/null 2>&1 || die "git is not installed."
command -v node >/dev/null 2>&1 || die "Node is not installed. Pi requires Node >= 22.19.0."
command -v pi   >/dev/null 2>&1 || die "Pi is not on PATH. Install it first: npm install -g @earendil-works/pi-coding-agent"

# --- where to put the checkout ------------------------------------------------
#
# On a throwaway machine, the checkout belongs on storage that survives a restart.
# Rather than naming any particular hosting provider, look for a writable mount that
# is not the root filesystem — that is what "persistent" means in a container — and
# fall back to the home directory when there is no such thing.

pick_dir() {
  if [ -n "${HARNESS_DIR:-}" ]; then
    printf '%s' "$HARNESS_DIR"
    return
  fi

  if [ "$(uname -s)" = "Linux" ]; then
    for candidate in /workspace /data /mnt/data /persist; do
      [ -d "$candidate" ] && [ -w "$candidate" ] || continue
      # Only if it is genuinely a separate mount, not just a directory on the overlay.
      mount_point="$(df -P "$candidate" 2>/dev/null | awk 'NR==2 {print $6}')"
      if [ -n "$mount_point" ] && [ "$mount_point" != "/" ]; then
        printf '%s/pi-universal-harness' "$candidate"
        return
      fi
    done
  fi

  printf '%s/pi-universal-harness' "${HOME:-/tmp}"
}

TARGET="$(pick_dir)"

step "Target"
ok "$TARGET"

if [ "$(uname -s)" = "Linux" ] && { [ -f /.dockerenv ] || grep -qiE 'docker|containerd|kubepods|lxc|podman' /proc/1/cgroup 2>/dev/null; }; then
  target_mount="$(df -P "$(dirname "$TARGET")" 2>/dev/null | awk 'NR==2 {print $6}')"
  if [ "$target_mount" = "/" ]; then
    warn "This looks like a container and $TARGET is on the root filesystem."
    warn "It will be lost when the container is recreated. Set HARNESS_DIR to a mounted volume to avoid that."
  fi
fi

# --- clone or update ----------------------------------------------------------

step "Fetching the harness"

if [ -d "$TARGET/.git" ]; then
  if [ -n "$(git -C "$TARGET" status --porcelain 2>/dev/null)" ]; then
    warn "Local changes present in $TARGET; leaving them alone and skipping the update."
  else
    git -C "$TARGET" fetch --quiet origin "$REF"
    git -C "$TARGET" checkout --quiet "$REF"
    git -C "$TARGET" merge --quiet --ff-only "origin/$REF" 2>/dev/null || true
    ok "updated to $(git -C "$TARGET" rev-parse --short HEAD)"
  fi
elif [ -e "$TARGET" ]; then
  die "$TARGET exists but is not a git checkout. Move it aside, or set HARNESS_DIR."
else
  mkdir -p "$(dirname "$TARGET")"
  git clone --quiet --branch "$REF" "$REPO" "$TARGET"
  ok "cloned at $(git -C "$TARGET" rev-parse --short HEAD)"
fi

# --- install ------------------------------------------------------------------

step "Installing"
"$TARGET/scripts/install.sh"

# --- next steps ---------------------------------------------------------------

printf '\n%sReady.%s\n\n' "$BOLD" "$RESET"
echo "Give the Judge a key — the harness reads the one Pi already has:"
echo
echo "    pi"
echo "    /login          → choose OpenRouter, paste your key"
echo "    /harness doctor → confirm everything is green"
echo
echo "There is nothing else to configure. To update later, re-run this same command."
echo
