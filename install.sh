#!/bin/sh
# The alfa install script.
#
#   curl -fsSL https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.sh | sh
#
# ── It does only three things: detect the platform, download, verify ──
# It doesn't touch shell config, doesn't write .bashrc, doesn't install dependencies. With
# an install script that stuffs things into your rc files, nobody can say which lines to
# delete when uninstalling. If the install directory isn't on PATH, it only **tells you**
# which line to add.
#
# ── Why verification is mandatory ──
# A binary cut off halfway through the download looks no different from a good one after
# chmod +x, and running it gives "cannot execute binary file" — a message with no clue at
# all pointing to "your download was cut off".
#
# Knobs:
#   ALFA_VERSION=v0.4.0   install a specific version (default: latest)
#   ALFA_INSTALL_DIR=…    install somewhere else (default ~/.local/bin)
#   ALFA_BASE_URL=…       fetch from somewhere else (a company mirror, an offline
#                           directory file:///…). This hook isn't only for testing: the
#                           machines that can't install things are often exactly the
#                           ones that can't reach the network
#   ALFA_SKIP_CHECKSUM=1  install even when it can't be verified. Use it **only** when
#                           you yourself are the provider of that mirror — by default,
#                           no verification means no install
set -eu

REPO="${ALFA_REPO:-alfa-plus-laboratory/alfa}"
VERSION="${ALFA_VERSION:-latest}"
INSTALL_DIR="${ALFA_INSTALL_DIR:-$HOME/.local/bin}"
NAME="alfa"

say() { printf '  %s\n' "$1"; }
die() { printf '\n  error: %s\n' "$1" >&2; exit 1; }

# ── Detect the platform ──
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  # Windows has its own (install.ps1) — rather than cobble together MSYS compatibility
  # code here that nobody has verified, point people at the path that has been
  *) die "unsupported system: $os (Windows: irm https://github.com/${REPO}/releases/latest/download/install.ps1 | iex)" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported architecture: $arch" ;;
esac

asset="alfa-${os}-${arch}"
if [ -n "${ALFA_BASE_URL:-}" ]; then
  base="${ALFA_BASE_URL%/}"
elif [ "$VERSION" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"

say "alfa installer"
say "platform  ${os}-${arch}"
say "release   ${VERSION}"

tmp="$(mktemp -d)"
# Every exit path must clean up — a failed install shouldn't leave 96MB behind in /tmp
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading …"
curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset" || die "download failed: $base/$asset"

# ── Verify ──
# ★ If it can't be verified, **stop** — not "mention it and install anyway".
#
# The three branches here (can't fetch checksums.txt / no line for this asset in it / no
# sha256 tool on the machine) used to print a `!` line and carry on installing. A
# man-in-the-middle who can't forge a certificate could then turn a verified install into
# an unverified one just by killing that **one** checksums.txt request — the warning
# scrolls past, the binary stays.
#
# The escape hatch is ALFA_SKIP_CHECKSUM=1, and it **must be typed out explicitly by a
# human**: an internal mirror or offline directory that ALFA_BASE_URL points to may really
# lack checksums.txt — that's a real scenario, but it should be a visible command, not a
# default path.
if ! curl -fsSL --retry 2 -o "$tmp/checksums.txt" "$base/checksums.txt" 2>/dev/null; then
  [ "${ALFA_SKIP_CHECKSUM:-}" = "1" ] ||
    die "cannot fetch $base/checksums.txt — refusing to install unverified (set ALFA_SKIP_CHECKSUM=1 to override)"
  say "! ALFA_SKIP_CHECKSUM=1 — installing without verification"
else
  expected="$(grep " $asset\$" "$tmp/checksums.txt" | awk '{print $1}')"
  if [ -z "$expected" ]; then
    [ "${ALFA_SKIP_CHECKSUM:-}" = "1" ] ||
      die "checksums.txt has no entry for $asset — refusing to install unverified (set ALFA_SKIP_CHECKSUM=1 to override)"
    say "! ALFA_SKIP_CHECKSUM=1 — installing without verification"
  else
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
    else
      [ "${ALFA_SKIP_CHECKSUM:-}" = "1" ] ||
        die "no sha256 tool found (need sha256sum or shasum) — refusing to install unverified (set ALFA_SKIP_CHECKSUM=1 to override)"
      actual=""
      say "! ALFA_SKIP_CHECKSUM=1 — installing without verification"
    fi
    if [ -n "$actual" ]; then
      [ "$actual" = "$expected" ] || die "checksum mismatch — expected $expected, got $actual"
      say "checksum ok"
    fi
  fi
fi

# ── Install ──
mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
chmod +x "$tmp/$asset"
# ⚠ Not atomic. $tmp is often on another filesystem (tmpfs /tmp on Linux), and there mv
# is "copy + delete": a copy cut off halfway leaves half an executable sitting on PATH.
# Tolerable here because recovering needs nothing from that file — rerun this script.
# `alfa upgrade` has no such fallback, so it stages next to the target and renames
# (src/update/upgrade.ts)
mv -f "$tmp/$asset" "$INSTALL_DIR/$NAME" || die "cannot write to $INSTALL_DIR"

say ""
say "installed  $INSTALL_DIR/$NAME"
"$INSTALL_DIR/$NAME" --version 2>/dev/null | sed 's/^/  version    /' || true

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "$INSTALL_DIR is not on your PATH. Add this to your shell profile:"
    printf '\n    export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac

say ""
say "run '$NAME' to set it up, or '$NAME upgrade' later to update in place"
