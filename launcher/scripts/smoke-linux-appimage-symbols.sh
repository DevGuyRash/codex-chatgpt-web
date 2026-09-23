#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: smoke-linux-appimage-symbols.sh /absolute/path/to.AppImage" >&2
  exit 64
fi
APPIMAGE_PATH="$1"
case "$APPIMAGE_PATH" in
  /*) ;;
  *) echo "AppImage smoke requires an absolute path" >&2; exit 64 ;;
esac
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-web-gpt-appimage-smoke.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
SMOKE_APPIMAGE="$TEMP_DIR/$(basename -- "$APPIMAGE_PATH")"
cp "$APPIMAGE_PATH" "$SMOKE_APPIMAGE"
chmod 0755 "$SMOKE_APPIMAGE"
(
  cd "$TEMP_DIR"
  "$SMOKE_APPIMAGE" --appimage-extract >/dev/null
)
APP_DIR="$TEMP_DIR/squashfs-root"
LIBNOTIFY="$(find "$APP_DIR" -type f -name 'libnotify.so.4' -print -quit)"
if [ -z "$LIBNOTIFY" ]; then
  echo "Final AppImage contains no libnotify.so.4" >&2
  exit 1
fi
# Electron 44.4.4's generated LibNotifyLoader resolves these symbols with dlsym.
# A newer host-only libnotify API is not a requirement of this pinned runtime.
REQUIRED_SYMBOLS="notify_is_initted notify_init notify_get_server_caps notify_get_server_info notify_notification_new notify_notification_add_action notify_notification_set_image_from_pixbuf notify_notification_set_timeout notify_notification_set_urgency notify_notification_set_hint notify_notification_show notify_notification_close"
AVAILABLE_SYMBOLS="$(nm -D --defined-only "$LIBNOTIFY" | awk '{print $3}')"
for symbol in $REQUIRED_SYMBOLS; do
  if ! printf '%s\n' "$AVAILABLE_SYMBOLS" | grep -Fxq "$symbol"; then
    echo "Final AppImage libnotify is missing Electron's required symbol: $symbol" >&2
    exit 1
  fi
done

EXECUTABLE=""
for candidate in "$APP_DIR"/*; do
  [ -f "$candidate" ] && [ -x "$candidate" ] || continue
  case "$(basename -- "$candidate")" in
    AppRun|chrome-sandbox|chrome_crashpad_handler) continue ;;
  esac
  if file "$candidate" | grep -q 'ELF .* executable'; then
    EXECUTABLE="$candidate"
    break
  fi
done
if [ -z "$EXECUTABLE" ]; then
  echo "Final AppImage contains no launcher executable" >&2
  exit 1
fi
RESOLUTION="$(LD_LIBRARY_PATH="$(dirname -- "$LIBNOTIFY")" ldd -r "$EXECUTABLE" 2>&1 || true)"
if printf '%s\n' "$RESOLUTION" | grep -Eq 'undefined symbol:|not found'; then
  printf '%s\n' "$RESOLUTION" >&2
  echo "Final AppImage has unresolved dynamic dependencies" >&2
  exit 1
fi
printf 'LINUX_APPIMAGE_SYMBOL_SMOKE_OK %s\n' "$LIBNOTIFY"
