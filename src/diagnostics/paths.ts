import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, join, win32, posix } from "node:path";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** Windows comparisons are case-insensitive and drive-aware; no string-prefix path guesses. */
export function containsPath(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const normalize = (path: string) => platform === "win32" ? paths.resolve(path).toLowerCase() : paths.resolve(path);
  const result = paths.relative(normalize(root), normalize(candidate));
  return result === "" || result !== ".." && !result.startsWith(`..${paths.sep}`) && !paths.isAbsolute(result);
}

/** Resolve existing ancestors even when the explicitly chosen output directory is not created yet. */
export function canonicalDestination(path: string): string {
  const full = resolve(path); let ancestor = dirname(full);
  while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) return full; ancestor = parent; }
  return join(realpathSync(ancestor), relative(ancestor, full));
}

export async function writeExport(destination: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${destination}.tmp-${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(data); await file.sync(); await file.close();
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, destination); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
}
