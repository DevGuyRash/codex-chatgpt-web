import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const suite = process.argv[2];
if (suite !== "non-ui" && suite !== "ui") throw new Error("Choose the non-ui or ui test suite");
const isUi = (name: string) => name.endsWith("-ui.test.ts") || name === "connector-menu-dom.test.ts";
const files = readdirSync(resolve("tests")).filter(name => name.endsWith(".test.ts") && isUi(name) === (suite === "ui")).sort().map(name => `tests/${name}`);
if (!files.length) throw new Error(`No ${suite} tests found`);
if (suite === "ui" && (!process.env.CHATGPT_TEST_CHROME_EXECUTABLE || !existsSync(process.env.CHATGPT_TEST_CHROME_EXECUTABLE))) throw new Error("UI gate incomplete: set CHATGPT_TEST_CHROME_EXECUTABLE to an installed Chromium executable");
const child = Bun.spawn([process.execPath, "test", ...files], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exitCode = await child.exited;
