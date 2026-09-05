import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotFile, writeFilesWithCompensation } from "../src/codex-integration-shared";
import { withConfigurationWriteLocks } from "../src/configuration-write-lock";

test("overlapping writers cannot commit while approval inputs are locked", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-writer-"));
  const config = join(dir, "config.toml");
  try {
    writeFileSync(config, "original");
    withConfigurationWriteLocks([config], () => {
      expect(() => writeFilesWithCompensation([{ path: config, data: "competitor" }])).toThrow("writer is busy");
      expect(readFileSync(config, "utf8")).toBe("original");
    });
    writeFilesWithCompensation([{ path: config, data: "reviewed" }]);
    expect(readFileSync(config, "utf8")).toBe("reviewed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed integration preserves edits made after a successful transaction write", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-transaction-"));
  try {
    const config = join(dir, "config.toml");
    writeFileSync(config, "original");
    expect(() => writeFilesWithCompensation([
      { path: config, data: "transaction" },
      { path: join(dir, "journal"), get data(): string {
        writeFileSync(config, "new user edit");
        throw new Error("injected second-write failure");
      } },
    ])).toThrow("preserved for manual recovery");
    expect(readFileSync(config, "utf8")).toBe("new user edit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback does not touch a file whose transaction write was never reached", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-transaction-"));
  try {
    const untouched = join(dir, "untouched");
    writeFileSync(untouched, "original");
    expect(() => writeFilesWithCompensation([
      { path: join(dir, "journal"), get data(): string {
        writeFileSync(untouched, "external edit");
        throw new Error("injected first-write failure");
      } },
      { path: untouched, data: "never written" },
    ])).toThrow();
    expect(readFileSync(untouched, "utf8")).toBe("external edit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed integration restores its own unchanged write", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-transaction-"));
  try {
    const config = join(dir, "config.toml");
    writeFileSync(config, "original");
    expect(() => writeFilesWithCompensation([
      { path: config, data: "transaction" },
      { path: join(dir, "journal"), get data(): string { throw new Error("injected second-write failure"); } },
    ])).toThrow();
    expect(readFileSync(config, "utf8")).toBe("original");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("approved preimages are revalidated before any transaction mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-transaction-"));
  try {
    const config = join(dir, "config.toml");
    writeFileSync(config, "approved original");
    const expected = [snapshotFile(config)];
    writeFileSync(config, "concurrent edit");
    expect(() => writeFilesWithCompensation([{ path: config, data: "proposal" }], [], { expected })).toThrow("changed since approval");
    expect(readFileSync(config, "utf8")).toBe("concurrent edit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed post-write verification compensates completed writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-transaction-"));
  try {
    const config = join(dir, "config.toml");
    writeFileSync(config, "original");
    expect(() => writeFilesWithCompensation([{ path: config, data: "proposal" }], [], {
      verify: () => { expect(readFileSync(config, "utf8")).toBe("proposal"); throw new Error("verification failed"); },
    })).toThrow("verification failed");
    expect(readFileSync(config, "utf8")).toBe("original");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
