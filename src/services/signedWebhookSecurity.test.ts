import { randomBytes } from "node:crypto";
import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
  InMemoryNonceStore,
  SignedWebhookSecurity,
} from "./signedWebhookSecurity";

const key = (id: string, activeFrom = 0, expiresAt?: number) => ({
  id,
  secret: Buffer.from(`${id}-webhook-secret-0123456789`),
  activeFrom,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

describe("SignedWebhookSecurity", () => {
  it("signs and verifies exact raw bytes", () => {
    const security = new SignedWebhookSecurity({ keys: [key("primary")] });
    const body = Buffer.from('{"marketId":"m-1","outcome":"yes"}');
    const signed = security.sign(body, 100, "a1b2c3d4");
    expect(signed.header).toMatch(/^v1=primary,t=100,n=a1b2c3d4,s=[a-f0-9]{64}$/);
    expect(security.verify(body, signed.header, 100)).toEqual({
      ok: true, keyId: "primary", timestamp: 100, nonce: "a1b2c3d4",
    });
  });

  it("rejects byte changes even when parsed JSON would be equivalent", () => {
    const security = new SignedWebhookSecurity({ keys: [key("primary")] });
    const signed = security.sign(Buffer.from('{"a":1,"b":2}'), 100, "abcdef12");
    expect(security.verify(Buffer.from('{"b":2,"a":1}'), signed.header, 100)).toEqual({
      ok: false, reason: "invalid_signature",
    });
  });

  it("rejects a nonce replay after a valid first verification", () => {
    const security = new SignedWebhookSecurity({ keys: [key("primary")] });
    const signed = security.sign(Buffer.from("payload"), 100, "deadbeef");
    expect(security.verify(Buffer.from("payload"), signed.header, 100).ok).toBe(true);
    expect(security.verify(Buffer.from("payload"), signed.header, 100)).toEqual({
      ok: false, reason: "nonce_replayed",
    });
  });

  it("rejects old and future timestamps at the tolerance boundary", () => {
    const security = new SignedWebhookSecurity({ keys: [key("primary")] });
    const old = security.sign(Buffer.from("old"), 1000, "11111111");
    const future = security.sign(Buffer.from("future"), 1000, "22222222");
    expect(security.verify(Buffer.from("old"), old.header, 1000 + DEFAULT_TIMESTAMP_TOLERANCE_SECONDS).ok).toBe(true);
    expect(security.verify(Buffer.from("future"), future.header, 1000 - DEFAULT_TIMESTAMP_TOLERANCE_SECONDS - 1)).toEqual({
      ok: false, reason: "timestamp_out_of_range",
    });
  });

  it("accepts an old key during its overlap window", () => {
    const security = new SignedWebhookSecurity({ keys: [key("old", 0, 200), key("new", 100)] });
    const old = security.sign(Buffer.from("old"), 50, "33333333");
    expect(security.verify(Buffer.from("old"), old.header, 50).ok).toBe(true);
    expect(security.verify(Buffer.from("old"), old.header, 200)).toEqual({ ok: false, reason: "key_not_active" });
  });

  it("uses the newest active key after rotation", () => {
    const security = new SignedWebhookSecurity({ keys: [key("old", 0), key("new", 100)] });
    expect(security.sign(Buffer.from("payload"), 99, "44444444").keyId).toBe("old");
    expect(security.sign(Buffer.from("payload"), 100, "55555555").keyId).toBe("new");
  });

  it("rejects unknown keys before consuming a nonce", () => {
    const security = new SignedWebhookSecurity({ keys: [key("primary")] });
    const external = new SignedWebhookSecurity({ keys: [key("foreign")] });
    const signed = external.sign(Buffer.from("payload"), 100, "66666666");
    expect(security.verify(Buffer.from("payload"), signed.header, 100)).toEqual({ ok: false, reason: "unknown_key" });
    expect(security.nonceCount).toBe(0);
  });

  it("rejects malformed headers without throwing", () => {
    const security = new SignedWebhookSecurity({ keys: [key("primary")] });
    for (const malformed of ["", "sha256=bad", "v1=primary,t=nope", "v1=primary,t=1,n=xyz,s=bad", "v1=primary,t=1,n=abcdef12,s=" + "0".repeat(63)]) {
      expect(security.verify(Buffer.from("payload"), malformed, 1)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("does not consume a nonce when the body signature is invalid", () => {
    const security = new SignedWebhookSecurity({ keys: [key("primary")] });
    const signed = security.sign(Buffer.from("payload"), 100, "77777777");
    const tampered = signed.header.replace(/s=[a-f0-9]+$/, `s=${"0".repeat(64)}`);
    expect(security.verify(Buffer.from("payload"), tampered, 100)).toEqual({ ok: false, reason: "invalid_signature" });
    expect(security.nonceCount).toBe(0);
  });

  it("expires nonce entries and permits the nonce after expiry", () => {
    const nonceStore = new InMemoryNonceStore();
    const security = new SignedWebhookSecurity({
      keys: [key("primary")], nonceStore, timestampToleranceSeconds: 1_000,
      nonceTtlSeconds: 10,
    });
    const signed = security.sign(Buffer.from("payload"), 100, "88888888");
    expect(security.verify(Buffer.from("payload"), signed.header, 100).ok).toBe(true);
    expect(nonceStore.prune(110)).toBe(1);
    expect(security.verify(Buffer.from("payload"), signed.header, 110).ok).toBe(true);
  });

  it("bounds nonce cache growth by evicting the oldest entry", () => {
    const nonceStore = new InMemoryNonceStore(2);
    expect(nonceStore.claim("key", "one", 100, 0)).toBe(true);
    expect(nonceStore.claim("key", "two", 100, 0)).toBe(true);
    expect(nonceStore.claim("key", "three", 100, 0)).toBe(true);
    expect(nonceStore.size()).toBe(2);
    expect(nonceStore.claim("key", "one", 100, 0)).toBe(true);
  });

  it("supports explicit rotation and removal", () => {
    const security = new SignedWebhookSecurity({ keys: [key("primary")] });
    security.rotate(key("secondary", 100));
    expect(security.listKeys().map((item) => item.id)).toEqual(["primary", "secondary"]);
    expect(security.removeKey("primary")).toBe(true);
    expect(security.removeKey("missing")).toBe(false);
    expect(security.listKeys().map((item) => item.id)).toEqual(["secondary"]);
  });

  it("rejects weak key configuration", () => {
    expect(() => new SignedWebhookSecurity({ keys: [] })).toThrow();
    expect(() => new SignedWebhookSecurity({ keys: [key("bad id!")] })).toThrow();
    expect(() => new SignedWebhookSecurity({ keys: [{ ...key("weak"), secret: randomBytes(4) }] })).toThrow();
    expect(() => new SignedWebhookSecurity({ keys: [key("bad-window", 10, 10)] })).toThrow();
  });
});
