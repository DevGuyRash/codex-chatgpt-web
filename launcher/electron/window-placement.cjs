const { screen } = require("electron");

function placeWindowNearLauncher(window, launcher) {
  const anchor = launcher && !launcher.isDestroyed()
    ? launcher.getBounds() : screen.getPrimaryDisplay().workArea;
  const workArea = screen.getDisplayMatching(anchor).workArea;
  const bounds = window.getBounds();
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = Math.max(workArea.x, Math.min(
    Math.round(anchor.x + (anchor.width - width) / 2),
    workArea.x + workArea.width - width,
  ));
  const y = Math.max(workArea.y, Math.min(
    Math.round(anchor.y + (anchor.height - height) / 2),
    workArea.y + workArea.height - height,
  ));
  window.setBounds({ x, y, width, height });
}

module.exports = { placeWindowNearLauncher };
