#!/bin/sh
# alfa 安装脚本。
#
#   curl -fsSL https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.sh | sh
#
# ── 它只做三件事:认平台、下、校验 ──
# 不改 shell 配置、不写 .bashrc、不装依赖。一个会往你 rc 文件里塞东西的安装
# 脚本,卸载时就没人说得清该删哪几行。PATH 里没有装到的目录,它只是**告诉你**
# 要加哪一行。
#
# ── 为什么必须校验 ──
# 下到一半断掉的二进制 chmod +x 之后和正常的看不出区别,而它跑起来是一句
# "cannot execute binary file" —— 那句话没有任何线索指向"你的下载断了"。
#
# 可调:
#   ALFA_VERSION=v0.4.0   装指定版本(默认最新)
#   ALFA_INSTALL_DIR=…    装到别处(默认 ~/.local/bin)
#   ALFA_BASE_URL=…       从别处取(公司内网镜像、离线目录 file:///…)。
#                           留这个口子不只是为了测试:装不了东西的机器往往
#                           正是出不了网的那些
#   ALFA_SKIP_CHECKSUM=1  验不了也照装。**只**在你自己就是那个镜像的
#                           提供方时用 —— 默认是验不了就拒绝安装
set -eu

REPO="${ALFA_REPO:-alfa-plus-laboratory/alfa}"
VERSION="${ALFA_VERSION:-latest}"
INSTALL_DIR="${ALFA_INSTALL_DIR:-$HOME/.local/bin}"
NAME="alfa"

say() { printf '  %s\n' "$1"; }
die() { printf '\n  error: %s\n' "$1" >&2; exit 1; }

# ── 认平台 ──
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  # Windows 有自己那份(install.ps1)—— 与其在这里硬凑一段没人验证过的 MSYS
  # 兼容代码,不如把人指到那条验证过的路上
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
# 任何一条退出路径都要清干净 —— 一个失败的安装不该在 /tmp 里留 96MB
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading …"
curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset" || die "download failed: $base/$asset"

# ── 校验 ──
# ★ 验不了就**停**,不是"说一声然后照装"。
#
# 这里原来的三条分支(取不到 checksums.txt / 里面没这一行 / 机器上没有
# sha256 工具)都是印一行 `!` 然后继续装。而一个伪造不了证书的中间人,
# 只要把 checksums.txt 这**一个**请求打掉,就能把一次已校验的安装变成
# 未校验的 —— 那行提示滚过去了,二进制留下了。
#
# 逃生开关是 ALFA_SKIP_CHECKSUM=1,而且**必须由人显式打出来**:
# ALFA_BASE_URL 指向的内网镜像或离线目录确实可能没有 checksums.txt,
# 那是真实场景,但它该是一条看得见的命令,不是一条默认路径。
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

# ── 装 ──
mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
chmod +x "$tmp/$asset"
# 同目录内先落地再 mv:跨文件系统的 mv 是"复制+删除",复制到一半断掉就是
# 半个可执行文件躺在 PATH 上
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
