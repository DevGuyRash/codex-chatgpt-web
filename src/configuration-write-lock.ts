import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalConfigurationPath } from "./codex-integration-target";

/** Cooperating processes exclude overlapping writes; foreign editors are covered by preimage checks. */
export function withConfigurationWriteLocks<T>(paths: readonly string[], action: () => T): T {
  const held: Array<{ path: string; identity: string }> = [];
  try {
    for (const source of [...new Set(paths.map(canonicalConfigurationPath))].sort()) {
      const path = `${source}.cgw-write.lock`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      let fd: number;
      try { fd = openSync(path, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new Error(`Configuration writer is busy or left an unfinished transaction: ${path}. Retry after it exits; if it crashed, inspect the configuration and recovery journal before removing this lock.`);
      }
      const identity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
      try { writeFileSync(fd, identity); held.push({ path, identity }); }
      finally { closeSync(fd); }
    }
    return action();
  } finally {
    for (const lock of held.reverse()) {
      // Never remove a replacement lock belonging to a different invocation.
      if (readFileSync(lock.path, "utf8") === lock.identity) unlinkSync(lock.path);
    }
  }
}
