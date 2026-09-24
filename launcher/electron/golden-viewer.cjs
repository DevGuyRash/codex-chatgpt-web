const fs = require("node:fs");
const path = require("node:path");

function ownsRecordedProcess(record) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid < 2 || record.group !== record.pid || typeof record.start !== "string" || typeof record.executable !== "string") return false;
  try {
    const stat = fs.readFileSync(`/proc/${record.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] === record.start && Number(fields[2]) === record.group && fs.realpathSync(`/proc/${record.pid}/exe`) === record.executable;
  } catch { return false; }
}

/** Resolve a private viewer only when every process and token still belongs to this workspace. */
function activeGoldenViewer(rootInput) {
  if (process.platform !== "linux") throw new Error("Hidden test desktops are currently available on Linux only");
  const root = path.resolve(rootInput);
  if (fs.realpathSync(root) !== root) throw new Error("The workspace must use its canonical directory path");
  const state = JSON.parse(fs.readFileSync(path.join(root, "workspace.json"), "utf8"));
  if (state.version !== 1 || state.root !== root || typeof state.display !== "string" || !/^:\d+$/.test(state.display)) throw new Error("Invalid isolated workspace identity");
  for (const name of ["display", "viewer-socket", "viewer", "launcher"]) {
    if (!ownsRecordedProcess(state.processes?.[name])) throw new Error(`The hidden ${name} process is no longer owned and running`);
  }
  const url = new URL(state.viewerUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/vnc.html" || url.hash) throw new Error("Invalid private viewer URL");
  if (url.searchParams.get("autoconnect") !== "true" || url.searchParams.get("resize") !== "scale" || url.searchParams.size !== 3) throw new Error("Invalid private viewer options");
  const viewerPath = url.searchParams.get("path");
  if (!viewerPath?.startsWith("websockify?token=")) throw new Error("Invalid private viewer token path");
  const token = viewerPath.slice("websockify?token=".length);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid private viewer token");
  const expected = `${token}: unix_socket:${path.join(root, "viewer.sock")}\n`;
  if (fs.readFileSync(path.join(root, "viewer-tokens"), "utf8") !== expected || !fs.existsSync(path.join(root, "viewer.sock"))) throw new Error("The private viewer token does not match its workspace");
  return { root, url: url.toString(), display: state.display };
}

module.exports = { activeGoldenViewer };
