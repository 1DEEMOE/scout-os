/**
 * Guardrail evals CLI. Run: pnpm --filter @wos/core evals
 * CI: packages/core/test/guardrail-evals.test.ts asserts 100% pass.
 */
import { runGuardrailChecks } from "./checks";

const results = runGuardrailChecks();
const suites = [...new Set(results.map((r) => r.suite))];
let failed = 0;
for (const s of suites) {
  const rs = results.filter((r) => r.suite === s);
  const bad = rs.filter((r) => !r.pass);
  failed += bad.length;
  console.log(`${s.padEnd(9)} ${rs.length - bad.length}/${rs.length} pass`);
  for (const b of bad) console.log(`  FAIL ${b.id}: ${b.detail}`);
}
console.log(failed === 0 ? `\nEVAL PASS (${results.length} checks)` : `\nEVAL FAIL (${failed}/${results.length} failed)`);
process.exit(failed === 0 ? 0 : 1);
