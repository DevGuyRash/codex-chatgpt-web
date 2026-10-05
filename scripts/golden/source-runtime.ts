import { resolve } from "node:path";
import { expandUserPath, loadConfig } from "../../src/config";
import { DEV_CONFIG_PURPOSE } from "../../src/dev-chat/constants";
import { resolveDevProfilePaths } from "../../src/dev-chat/profile";

/** Golden borrows DEV's configured tunnel by default, never its authenticated browser profile. */
export function readGoldenSourceRuntime(sourceHome?: string, options: Parameters<typeof resolveDevProfilePaths>[0] = {}) {
  if (sourceHome !== undefined && !sourceHome.trim()) throw new Error("An explicit golden source runtime home must not be empty");
  const home = sourceHome === undefined ? resolveDevProfilePaths(options).home : resolve(expandUserPath(sourceHome));
  const config = loadConfig(home);
  if (sourceHome === undefined && config.purpose !== DEV_CONFIG_PURPOSE) {
    throw new Error("The default golden source requires a DEV dev-harness configuration; another runtime must be selected explicitly");
  }
  return { home, config };
}
