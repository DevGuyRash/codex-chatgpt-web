import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { activeGoldenViewer } = require("../../launcher/electron/golden-viewer.cjs") as {
  activeGoldenViewer(root: string): { root: string; url: string; display: string };
};
const [action, directory] = process.argv.slice(2);
if (!directory || (action !== "url" && action !== "open" && action !== "status")) {
  throw new Error("Usage: bun scripts/golden/viewer.ts <url|open|status> <workspace-directory>");
}
const viewer = activeGoldenViewer(resolve(directory));
if (action === "url") process.stdout.write(`${viewer.url}\n`);
else if (action === "status") process.stdout.write(`Owned hidden launcher is running on ${viewer.display}.\n`);
else {
  const child = spawn("xdg-open", [viewer.url], { stdio: "ignore", detached: true });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  process.stdout.write("Opened the owned hidden launcher desktop in your browser.\n");
}
