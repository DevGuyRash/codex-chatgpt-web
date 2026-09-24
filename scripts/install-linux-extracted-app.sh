#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  printf 'Usage: sudo bash %s EXTRACTED_APPDIR /opt/codex-web-gpt[-dev]/app-NAME EXPECTED_APP_ASAR_SHA256\n' "$0" >&2
  exit 2
fi
if [[ "$(uname -s)" != Linux || $EUID -ne 0 ]]; then
  printf 'Run this installer as root on Linux from a visible terminal.\n' >&2
  exit 2
fi

source_root=${1%/}
destination=${2%/}
expected_hash=$3
if [[ "$source_root" != /* || -L "$source_root" || ! -d "$source_root" || ! -x "$source_root/AppRun"
  || ! -f "$source_root/resources/app.asar" ]]; then
  printf 'The source must be an absolute extracted AppImage directory with AppRun and resources/app.asar.\n' >&2
  exit 2
fi
if [[ ! "$destination" =~ ^/opt/codex-web-gpt(-dev)?/app-[A-Za-z0-9._-]+$ ]]; then
  printf 'The destination must be a new app-NAME directory under /opt/codex-web-gpt or /opt/codex-web-gpt-dev.\n' >&2
  exit 2
fi
if [[ ! "$expected_hash" =~ ^[a-f0-9]{64}$ ]]; then
  printf 'Expected app.asar SHA-256 must be 64 lowercase hexadecimal characters.\n' >&2
  exit 2
fi

source_hash=$(sha256sum "$source_root/resources/app.asar" | cut -d' ' -f1)
if [[ "$source_hash" != "$expected_hash" ]]; then
  printf 'Extracted app.asar hash differs from the reviewed build.\n' >&2
  exit 1
fi
parent=${destination%/*}
if [[ -L "$parent" || ( -e "$parent" && ! -d "$parent" ) || -e "$destination" || -L "$destination" ]]; then
  printf 'The destination or its parent is not a new ordinary directory.\n' >&2
  exit 1
fi
if [[ ! -e "$parent" ]]; then install -d -m 755 "$parent"; fi
if [[ $(stat -c %u "$parent") != 0
  || -n $(find "$parent" -maxdepth 0 -perm /022 -print -quit) ]]; then
  printf 'The destination parent must be root-owned and not group/world writable.\n' >&2
  exit 1
fi

cp -a --no-preserve=ownership -- "$source_root" "$destination"
# AppImage extraction gives every directory mode 700 on some hosts. Preserve root ownership
# while making the application traversable, and never retain world-writable extracted files.
find "$destination" -type d -exec chmod 755 {} +
find "$destination" -type f -perm /022 -exec chmod go-w {} +

installed_hash=$(sha256sum "$destination/resources/app.asar" | cut -d' ' -f1)
if [[ "$installed_hash" != "$expected_hash" || $(stat -c %u "$destination/AppRun") != 0 ]]; then
  printf 'Installed app identity or ownership verification failed; do not launch it.\n' >&2
  exit 1
fi
printf 'Verified root-owned launcher at %s\n' "$destination"
