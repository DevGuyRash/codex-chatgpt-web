import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFilesWithCompensation } from "../src/codex-integration-shared";

test("failed integration preserves edits made after a successful transaction write", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-transaction-"));
  try {
    const config = join(dir, "config.toml");
    const obstruction = join(dir, "not-a-directory");
    writeFileSync(config, "original");
    writeFileSync(obstruction, "file");
    expect(() => writeFilesWithCompensation([
      { path: config, data: "transaction" },
      { path: join(obstruction, "journal"), get data() {
        writeFileSync(config, "new user edit");
        return "journal";
      } },
    ])).toThrow("preserved for manual recovery");
    expect(readFileSync(config, "utf8")).toBe("new user edit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rollback does not touch a file whose transaction write was never reached", () => {
  const dir = mkdtempSync(join(tmpdir(), "integration-transaction-"));
  try {
    const untouched = join(dir, "untouched");
    const obstruction = join(dir, "not-a-directory");
    writeFileSync(untouched, "original");
    writeFileSync(obstruction, "file");
    expect(() => writeFilesWithCompensation([
      { path: join(obstruction, "journal"), get data() {
        writeFileSync(untouched, "external edit");
        return "journal";
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
    const obstruction = join(dir, "not-a-directory");
    writeFileSync(config, "original");
    writeFileSync(obstruction, "file");
    expect(() => writeFilesWithCompensation([
      { path: config, data: "transaction" },
      { path: join(obstruction, "journal"), data: "journal" },
    ])).toThrow();
    expect(readFileSync(config, "utf8")).toBe("original");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
