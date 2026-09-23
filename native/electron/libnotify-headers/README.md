# Pinned libnotify build headers

These five unmodified libnotify 0.8.8 public headers fill the missing development-header portion of Electron's owned Debian sysroot for the Linux build. Their exact SHA-256 values are pinned in `../manifest.json`; the build script refuses a conflicting sysroot copy. No libnotify library or user configuration is copied into the launcher by this step.

libnotify is licensed under LGPL-2.1-or-later. The headers retain their copyright notices; the full LGPL text is in [`LICENSES/libnotify-0.8.7-LGPL-2.1.md`](../../../LICENSES/libnotify-0.8.7-LGPL-2.1.md), and the 0.8.8 source release is available from [GNOME](https://download.gnome.org/sources/libnotify/0.8/libnotify-0.8.8.tar.xz).
