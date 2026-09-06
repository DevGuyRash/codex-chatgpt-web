import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DiagnosticsClient } from "../src/diagnostics/client";
import { QueryResultSchema, StatusSchema, type DiagnosticEvent } from "../src/diagnostics/contracts";

/** Exercise shipped modules using the bundled executable, outside the build/source directory. */
export async function smokeDiagnostics(executable: string, entrypoint: string, home: string): Promise<void> {
  const args = [entrypoint, "--home", home, "diagnostics"];
  const client = new DiagnosticsClient({ executable, args: [...args, "worker"], cwd: home });
  const traceId = "a".repeat(32);
  const event: DiagnosticEvent = { version: 1, id: crypto.randomUUID(), time: Date.now(), kind: "problem", name: "packaged.failure", body: "Packaged synthetic failure", severity: "error", component: "package-test", environment: "test", target: "fixture", traceId,
    attributes: { "service.version": "package-fixture" }, problem: { version: 1, code: "package_test", message: "Packaged synthetic failure", recovery: "not-needed", findings: [], causes: [], actions: ["open-diagnostics"] } };
  try {
    const initialStatus = await client.status();
    if (!initialStatus.available) throw new Error(`Packaged diagnostic worker could not open SQLite: ${initialStatus.notices.join("; ")}`);
    await client.request({ method: "append", events: [event] });
    const result = await client.query({ regex: "synthetic failure", traceId });
    if (result.events[0]?.id !== event.id) throw new Error("Packaged regex worker did not return its correlated record");
  } finally { await client.close(); }
  const command = async (...command: string[]) => {
    const child = Bun.spawn([executable, ...args, ...command], { cwd: home, stdout: "pipe", stderr: "pipe" });
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error("Packaged diagnostic CLI failed");
    return JSON.parse(stdout) as unknown;
  };
  const status = StatusSchema.parse(await command("status", "--json"));
  if (!status.available || status.eventCount !== 1) throw new Error("Packaged read-only status did not find retained evidence");
  const result = QueryResultSchema.parse(await command("search", "synthetic", "--json"));
  if (result.events[0]?.traceId !== traceId) throw new Error("Packaged independent CLI search lost correlation");
  const output = join(home, "report 日本語.html");
  await command("export", "--output", output, "--format", "html");
  if (!readFileSync(output, "utf8").includes("Collection health")) throw new Error("Packaged report is missing collection health");
  if (process.platform !== "win32" && (statSync(output).mode & 0o777) !== 0o600) throw new Error("Packaged report permissions are not private");
  process.stdout.write("RELOCATABLE_DIAGNOSTICS_SMOKE_OK\n");
}
