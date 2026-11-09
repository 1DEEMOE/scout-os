/**
 * Operator command: re-seal every stored secret under the current key.
 *   pnpm --filter @wos/core rotate-secrets -- --confirm <new-key-id> [--dry-run]
 * Needs WOS_SECRETS_KEY(+_ID), WOS_SECRETS_KEY_PREVIOUS(+_ID), DATABASE_URL_ADMIN
 * and DATABASE_URL. See docs/plans/secrets-rotation-runbook.md.
 */
import { closePool } from "@wos/db";
import { rotateStoredSecrets } from "../src/secrets-rotate";

const args = process.argv.slice(2);
const confirm = args[args.indexOf("--confirm") + 1] ?? "";
const dryRun = args.includes("--dry-run");

rotateStoredSecrets({ confirmKeyId: args.includes("--confirm") ? confirm : "", dryRun })
  .then(async (r) => {
    for (const t of r.tables) console.log(`${t.table}: ${t.total} rows, ${t.resealed} ${r.dryRun ? "would be " : ""}re-sealed, ${t.alreadyCurrent} already on ${r.keyId}, ${t.unreadable.length} unreadable`);
    const unreadable = r.tables.flatMap((t) => t.unreadable.map((u) => `${t.table} ${u.id} (key ${u.keyId ?? "?"})`));
    if (unreadable.length) {
      console.error(`Left untouched, could not be opened:\n  ${unreadable.join("\n  ")}`);
      process.exitCode = 2;
    }
    await closePool();
  })
  .catch(async (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    await closePool();
  });
