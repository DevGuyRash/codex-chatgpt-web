import { isAbsolute, join, resolve } from "node:path";
import { runDiagnosticsWorker } from "./worker";

// The private diagnostics process needs only its owned store, not the CLI's setup,
// browser, tunnel, and model adapters. Launcher and runtime owners pass one exact home.
if (process.argv.length !== 4 || process.argv[2] !== "--home"
  || !isAbsolute(process.argv[3]!)) {
  throw new Error("Diagnostics worker requires one absolute --home path");
}

await runDiagnosticsWorker(join(resolve(process.argv[3]!), "diagnostics", "observability"));
