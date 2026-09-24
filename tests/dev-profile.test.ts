import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  devLauncherEnvironment,
  installedLauncherCandidates,
  launchDevProfile,
  readDevChatExperimentalFeatures,
  resolveDevProfilePaths,
} from "../src/dev-chat/profile";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

test("DEV profile paths isolate browser, Codex, config, chat, and runtime state", () => {
  const homeDirectory = "/Users/tester";
  const devHome = resolve(homeDirectory, "development");
  const paths = resolveDevProfilePaths({
    homeDirectory,
    environment: {
      CODEX_CHATGPT_WEB_HOME: join(homeDirectory, "production"),
      CODEX_WEB_GPT_DEV_HOME: join(homeDirectory, "development"),
    },
  });
  expect(paths).toEqual({
    home: devHome,
    codexHome: join(devHome, "codex-home"),
    launcherUserData: join(devHome, "launcher"),
    launcherStatePath: join(devHome, "launcher", "launcher-state.json"),
    descriptorPath: join(devHome, "runtime", "launcher-browser.json"),
    chatsPath: join(devHome, "chats"),
    runtimePath: join(devHome, "runtime", "dev-chat"),
    configPath: join(devHome, "config.json"),
  });
});

test("Bigger Context is disabled by default and read from the isolated DEV runtime config", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-gpt-dev-features-"));
  try {
    const paths = resolveDevProfilePaths({
      homeDirectory: root,
      environment: { CODEX_WEB_GPT_DEV_HOME: join(root, "dev") },
    });
    expect(readDevChatExperimentalFeatures(paths)).toEqual({ biggerContext: false });
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.configPath, JSON.stringify({
      version: 3,
      experimentalBiggerContext: true,
    }));
    expect(readDevChatExperimentalFeatures(paths)).toEqual({ biggerContext: true });
    writeFileSync(paths.configPath, JSON.stringify({
      version: 3,
      experimentalBiggerContext: "yes",
    }));
    expect(() => readDevChatExperimentalFeatures(paths)).toThrow("Invalid Bigger Context preference");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV profile path refuses production home reuse", () => {
  const shared = "/Users/tester/shared";
  expect(() => resolveDevProfilePaths({
    homeDirectory: "/Users/tester",
    environment: {
      CODEX_CHATGPT_WEB_HOME: shared,
      CODEX_WEB_GPT_DEV_HOME: shared,
    },
  })).toThrow("must differ from the production");
});

test("installed launcher discovery has explicit platform candidates", () => {
  expect(installedLauncherCandidates({
    platform: "darwin",
    homeDirectory: "/Users/tester",
    environment: {},
  })).toEqual([
    "/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT",
    "/Users/tester/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT",
  ]);
  expect(installedLauncherCandidates({
    platform: "linux",
    homeDirectory: "/home/tester",
    environment: { PATH: "/usr/local/bin:/usr/bin" },
  })).toEqual([
    "/home/tester/.local/bin/codex-web-gpt",
    "/usr/local/bin/codex-web-gpt",
    "/usr/bin/codex-web-gpt",
  ]);
  expect(installedLauncherCandidates({
    platform: "win32",
    homeDirectory: "C:\\Users\\tester",
    environment: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
  })).toEqual([
    "C:\\Users\\tester\\AppData\\Local\\Programs\\Codex Web GPT\\Codex Web GPT.exe",
  ]);
  expect(installedLauncherCandidates({
    platform: "win32",
    homeDirectory: "C:\\Users\\tester",
    environment: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    windowsInstallLocation: "D:\\Apps\\Codex Web GPT",
  })).toEqual([
    "D:\\Apps\\Codex Web GPT\\Codex Web GPT.exe",
  ]);
});

test("DEV launcher child cannot inherit production home or browser-profile overrides", () => {
  const paths = resolveDevProfilePaths({
    homeDirectory: "/Users/tester",
    environment: {
      CODEX_CHATGPT_WEB_HOME: "/Users/tester/production",
      CODEX_WEB_GPT_DEV_HOME: "/Users/tester/development",
    },
  });
  expect(devLauncherEnvironment(paths, {
    KEEP_ME: "yes",
    CODEX_CHATGPT_WEB_HOME: paths.home,
    CODEX_HOME: "/Users/tester/production-codex",
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: "/Users/tester/production-launcher",
  })).toEqual({
    KEEP_ME: "yes",
    CODEX_WEB_GPT_DEV_HOME: paths.home,
  });
});

test("a dead DEV descriptor cannot block an explicit reviewed launcher restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-gpt-dev-dead-owner-"));
  const paths = resolveDevProfilePaths({
    homeDirectory: root,
    environment: { CODEX_WEB_GPT_DEV_HOME: join(root, "dev") },
  });
  const executable = join(root, "reviewed-launcher");
  const helperScript = join(root, "helper.cjs");
  try {
    mkdirSync(join(paths.home, "runtime"), { recursive: true });
    writeFileSync(executable, '#!/bin/sh\nprintf started > "$CODEX_WEB_GPT_DEV_HOME/started"\n', { mode: 0o755 });
    writeFileSync(helperScript, "module.exports = {};\n");
    writeFileSync(paths.descriptorPath, `${JSON.stringify({
      version: 3,
      kind: "codex-web-gpt-launcher",
      profile: "development",
      pid: 999999999,
      endpoint: "http://127.0.0.1:48121",
      control: { endpoint: "http://127.0.0.1:48122", token: "a".repeat(64) },
      helper: { executable: process.execPath, script: helperScript },
      partition: "persist:codex-web-gpt-dev-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "d".repeat(32),
      surfaceTargets: { ["d".repeat(32)]: "dev_native_target_0123456789abcdef" },
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    await expect(launchDevProfile(paths, { executable, timeoutMs: 250 }))
      .rejects.toThrow("DEV launcher did not become ready");
    expect(existsSync(join(paths.home, "started"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
