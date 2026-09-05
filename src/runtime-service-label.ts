import { basename, dirname } from "node:path";
import { getConfigDir } from "./config";

/** CLI binds one owning home before dispatch. Named targets use the resolver's durable directory. */
export function runtimeServiceLabel(base: string, runtimeHome = getConfigDir()): string {
  const identity = basename(runtimeHome);
  return basename(dirname(runtimeHome)) === "targets" && /^[a-f0-9]{24}$/.test(identity) ? `${base}.${identity}` : base;
}
