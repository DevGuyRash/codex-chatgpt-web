import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { TunnelConfig } from "./config";
import { DiagnosticError } from "./diagnostics/problems";

function failure(code: string, message: string, osCode?: string): never {
  throw new DiagnosticError({ code, message, origin: "tunnel-profile", stage: "tunnel.health_discovery", retryable: false,
    ...(osCode && /^[A-Z0-9_]{1,96}$/.test(osCode) ? { findings: [{ message: `osCode=${osCode}` }] } : {}),
  });
}

function readBoundedFile(path: string, maxBytes: number, kind: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) failure("tunnel_health_locator_invalid", `The tunnel ${kind} must be a bounded regular file`);
    const bytes = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > maxBytes) failure("tunnel_health_locator_invalid", `The tunnel ${kind} exceeded its size limit`);
    return bytes.subarray(0, used).toString("utf8");
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    // Filesystem and YAML errors may embed profile content. Never include the raw source.
    return failure("tunnel_health_locator_unavailable", `The tunnel ${kind} could not be read`, error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined);
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Resolve the native client's documented health.url_file without reading key references or contacting its control plane. This locates an endpoint; callers still verify live health. */
export function tunnelHealthLocator(tunnel: TunnelConfig): { baseUrl: string } {
  if (!isAbsolute(tunnel.profileDir) || !/^[A-Za-z0-9._-]+$/.test(tunnel.profileName) || [".", ".."].includes(tunnel.profileName)) {
    failure("tunnel_health_locator_invalid", "The configured tunnel profile location is invalid");
  }
  const source = readBoundedFile(join(tunnel.profileDir, `${tunnel.profileName}.yaml`), 1024 * 1024, "profile");
  let profile: any;
  try { profile = Bun.YAML.parse(source); }
  catch { failure("tunnel_health_profile_invalid", "The tunnel profile is not valid YAML; its content is excluded from diagnostics"); }
  if (!profile || typeof profile !== "object" || profile.control_plane?.tunnel_id !== tunnel.tunnelId) {
    failure("tunnel_health_identity_mismatch", "The generated profile does not identify the configured tunnel");
  }
  const locator = profile.health?.url_file;
  if (typeof locator !== "string" || !isAbsolute(locator)) failure("tunnel_health_locator_invalid", "The tunnel profile has no absolute health URL file");
  const value = readBoundedFile(locator, 4096, "health URL file").trim();
  let url: URL;
  try { url = new URL(value); }
  catch { failure("tunnel_health_endpoint_invalid", "The tunnel health URL file has no valid endpoint"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    failure("tunnel_health_endpoint_invalid", "The tunnel health URL must be an uncredentialed loopback HTTP base URL with an explicit port");
  }
  return { baseUrl: url.origin };
}
