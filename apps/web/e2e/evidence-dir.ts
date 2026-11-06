import { mkdirSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

/**
 * Where a browser test writes screenshots and timing notes.
 * Set WOS_EVIDENCE_DIR to a root (absolute, or relative to the repo).
 * The default is apps/web/test-results/evidence, which CI can create.
 * Never a machine-specific path such as /workspace/scout-os.
 */
export function evidenceDir(name: string): string {
  const override = process.env.WOS_EVIDENCE_DIR;
  const root = override
    ? path.resolve(repoRoot, override)
    : path.resolve(import.meta.dirname, "../test-results/evidence");
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
