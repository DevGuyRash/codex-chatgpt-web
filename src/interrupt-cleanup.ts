import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { interruptActiveTurn } from "./service";

type Identity = { threadId: string; turnId: string };
const key = (identity: Identity) => createHash("sha256").update(JSON.stringify([identity.threadId, identity.turnId])).digest("hex");

/** Minimal unresolved-work evidence survives a runtime crash; contains no prompt or raw turn ID. */
export class InterruptCleanupClaims {
  private directory: string;
  private owned = new Set<string>();
  constructor(runtimeHome: string) { this.directory = join(runtimeHome, "runtime", "interrupt-cleanup"); }
  begin(identity: Identity): () => void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = `${key(identity)}.${randomUUID()}`;
    const path = join(this.directory, file);
    writeFileSync(path, "unconfirmed\n", { mode: 0o600, flag: "wx" });
    this.owned.add(file);
    return () => { try { unlinkSync(path); this.owned.delete(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
  }
  has(identity: Identity): boolean { return this.files(identity).length > 0; }
  captureSettlement(identity: Identity): () => void {
    const files = this.files(identity).filter(file => this.owned.has(file));
    return () => { for (const file of files) { try { unlinkSync(join(this.directory, file)); this.owned.delete(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } } };
  }
  private files(identity: Identity): string[] {
    if (!existsSync(this.directory)) return [];
    const prefix = `${key(identity)}.`;
    return readdirSync(this.directory).filter(file => file.startsWith(prefix) && /^[a-f0-9]{64}\.[a-f0-9-]{36}$/.test(file));
  }
}

export async function deliverInterruptCleanup(config: AppConfig | undefined, identity: Identity, claims: InterruptCleanupClaims): Promise<string | undefined> {
  // Always deliver when possible, including before request registration. Disk evidence is only
  // for unavailable-runtime diagnostics; it must never gate authenticated cancellation delivery.
  try {
    if (!config) throw new Error("Runtime configuration is unavailable");
    const result = await interruptActiveTurn(config, identity);
    if ((result.cleanupStatus === "completed" || result.cleanupStatus === "armed") && !claims.has(identity)) return;
    if (result.cancelledHttpTurns || result.cancelledBrowserTurns || claims.has(identity)) return "This bridge accepted the exact-turn cleanup request, but physical cleanup is not yet confirmed. Check this target's runtime diagnostics before assuming its browser work has stopped.";
  } catch {
    if (claims.has(identity)) return "This turn reached this bridge, but the runtime could not confirm cleanup. Its browser work may still be running; inspect this target's runtime and browser. This cleanup request is restricted to the exact turn.";
  }
}
