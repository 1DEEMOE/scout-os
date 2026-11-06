import { Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { makeLogger, REDACT_PATHS, scrubPii } from "../src/logger";

describe("scrubPii (G8)", () => {
  it("redacts values under PII field names, at any depth", () => {
    const out = scrubPii({
      body: "hello there",
      nested: { subject: "hi", deeper: { content: "secret", safe: 42 } },
    }) as { body: string; nested: { subject: string; deeper: { content: string; safe: number } } };
    expect(out.body).toBe("[REDACTED]");
    expect(out.nested.subject).toBe("[REDACTED]");
    expect(out.nested.deeper.content).toBe("[REDACTED]");
    expect(out.nested.deeper.safe).toBe(42);
  });

  it("masks email addresses inside ordinary strings", () => {
    expect(scrubPii("reply to jane.doe@acme-corp.com please")).toBe("reply to [email] please");
    expect(scrubPii({ note: "cc: a@b.co, c@d.org" })).toEqual({ note: "cc: [email], [email]" });
  });

  it("leaves ids, counts, enums and timestamps untouched", () => {
    const at = "2026-11-05T12:00:00.000Z";
    expect(scrubPii({ tenantId: "org_1", count: 3, action: "inbox.sync", at })).toEqual({ tenantId: "org_1", count: 3, action: "inbox.sync", at });
  });

  it("scrubs Error messages without keeping the stack", () => {
    const out = scrubPii({ err: new Error("smtp refused for bob@example.test") }) as { err: Record<string, unknown> };
    expect(out.err.name).toBe("Error");
    expect(out.err.message).toBe("smtp refused for [email]");
    expect(out.err.stack).toBeUndefined();
  });

  it("caps recursion and never mutates its input", () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 20; i++) cur = cur.next = { note: "x@y.zz" };
    const before = JSON.stringify(deep);
    expect(() => scrubPii(deep)).not.toThrow();
    expect(JSON.stringify(deep)).toBe(before);
  });
});

describe("makeLogger", () => {
  // The suite sets LOG_LEVEL=silent; these tests need an emitting logger.
  const prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "info";
  afterAll(() => {
    if (prevLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prevLevel;
  });

  function capture() {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    return { lines, stream };
  }

  it("redacts secrets by path and PII by value in emitted lines", async () => {
    const { lines, stream } = capture();
    const log = makeLogger(stream);
    log.info({ password: "hunter2", headers: { authorization: "Bearer x" }, mail: { to: "a@b.co", subject: "hi" }, msg: "mail from c@d.org" }, "hello");
    await new Promise((r) => setImmediate(r));
    const line = lines.join("");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("Bearer x");
    expect(line).not.toContain("a@b.co");
    expect(line).toContain("[email]");
  });

  it("covers credential field names including authorization and tokens", () => {
    for (const f of ["password", "token", "accessToken", "refreshToken", "secretCiphertext", "tokens", "authorization"]) {
      expect(REDACT_PATHS).toContain(f);
      expect(REDACT_PATHS).toContain(`*.${f}`);
    }
    expect(REDACT_PATHS).toContain("headers.cookie");
    expect(REDACT_PATHS).toContain("headers.authorization");
  });
});
