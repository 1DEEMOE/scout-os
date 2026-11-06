import { describe, expect, it } from "vitest";
import config, { SECURITY_HEADERS } from "../next.config";

// Phase 0 finding E-2: pages (especially Approvals) must not be frameable.
describe("security headers", () => {
  it("apply to every path and forbid framing", async () => {
    const rules = await config.headers!();
    expect(rules).toEqual([{ source: "/:path*", headers: SECURITY_HEADERS }]);
    const h = Object.fromEntries(SECURITY_HEADERS.map((x) => [x.key, x.value]));
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(config.poweredByHeader).toBe(false);
  });
});
