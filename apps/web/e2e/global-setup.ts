import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

// Seeds synthetic users, an org, and two tasks
// waiting for approval (tier 2 and tier 4). Runs in a child process so the
// test runner doesn't hold database connections.
export default function globalSetup() {
  const out = execSync("npx tsx e2e/seed.ts", { cwd: path.resolve(import.meta.dirname, ".."), env: process.env }).toString();
  const json = out.trim().split("\n").at(-1)!;
  writeFileSync(path.resolve(import.meta.dirname, ".seed.json"), json);
}
