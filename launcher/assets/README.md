# Launcher icons

`icon.svg` and `icon.png` are the normal application icon. `dev-icon.svg` overlays the normal raster icon with a teal DEV treatment, and `dev-icon.png` is the committed runtime asset. To regenerate the DEV raster after changing either source, run `rsvg-convert -w 1024 -h 1024 launcher/assets/dev-icon.svg -o launcher/assets/dev-icon.png` from the repository root. Packaging and startup use the committed PNG, so contributors do not need SVG tools to build or launch the app.
