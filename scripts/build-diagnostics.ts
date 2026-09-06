import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
for (const [entry, name] of [["launcher/diagnostics/host.ts", "diagnostics.cjs"], ["launcher/electron/preload.cjs", "preload.cjs"]]) {
  const result = await Bun.build({ entrypoints: [resolve(root, entry)], target: "node", format: "cjs", external: ["electron"],
    outdir: resolve(root, "launcher/electron/generated"), naming: name, sourcemap: "external" });
  if (!result.success) throw new Error(`Diagnostics build failed: ${result.logs.join("\n")}`);
}
