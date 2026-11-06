import { describe, expect, it } from "vitest";
import { createState, verifyState } from "../src/server/oauth-state";

describe("OAuth state", () => {
  it("accepts the same user with the matching cookie, within 10 minutes", () => {
    const { state, nonce } = createState("org-1", "user-1", 1_000);
    expect(verifyState(state, nonce, "user-1", 2_000)).toMatchObject({ orgId: "org-1", userId: "user-1" });
  });

  it("rejects another user, a missing or wrong cookie, tampering, and expiry", () => {
    const { state, nonce } = createState("org-1", "user-1", 1_000);
    expect(verifyState(state, nonce, "user-2", 2_000)).toBeNull();
    expect(verifyState(state, undefined, "user-1", 2_000)).toBeNull();
    expect(verifyState(state, "other", "user-1", 2_000)).toBeNull();
    const [payload, mac] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ orgId: "org-EVIL", userId: "user-1", nonce, exp: 9e12 })).toString("base64url");
    expect(verifyState(`${forged}.${mac}`, nonce, "user-1", 2_000)).toBeNull();
    expect(verifyState(`${payload}.x`, nonce, "user-1", 2_000)).toBeNull();
    expect(verifyState(state, nonce, "user-1", 1_000 + 11 * 60 * 1000)).toBeNull();
  });
});
