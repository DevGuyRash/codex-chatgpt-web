import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const scenario of ["slow", "coalesce", "failure", "owner", "shutdown"]) {
  test(`continuation snapshot persistence: ${scenario}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "response-state-"));
    const child = Bun.spawn([process.execPath, resolve("tests/fixtures/response-state-persistence.ts"), scenario], {
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER: "", CODEX_CHATGPT_WEB_DIAGNOSTICS_FD: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 4_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    } finally {
      clearTimeout(deadline);
      child.kill();
      await child.exited;
      rmSync(home, { recursive: true, force: true });
    }
  });
}
