import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;
export const DEFAULT_NONCE_TTL_SECONDS = 600;
export const MAX_SIGNING_KEYS = 8;

export type SigningKey = {
  id: string;
  secret: Buffer;
  activeFrom: number;
  expiresAt?: number;
};

export type SignedWebhook = {
  keyId: string;
  timestamp: number;
  nonce: string;
  signature: string;
  header: string;
};

export type VerificationFailure =
  | "malformed"
  | "unknown_key"
  | "key_not_active"
  | "timestamp_out_of_range"
  | "nonce_replayed"
  | "invalid_signature";

export type VerificationResult = { ok: true; keyId: string; timestamp: number; nonce: string } | { ok: false; reason: VerificationFailure };

export interface NonceStore {
  claim(namespace: string, nonce: string, expiresAt: number, now: number): boolean;
  prune(now: number): number;
  size(): number;
}

/** Bounded replay cache; claiming is synchronous and therefore atomic in-process. */
export class InMemoryNonceStore implements NonceStore {
  private readonly entries = new Map<string, number>();
  constructor(private readonly maxEntries = 10_000) {}

  claim(namespace: string, nonce: string, expiresAt: number, now: number): boolean {
    this.prune(now);
    const key = `${namespace}\u0000${nonce}`;
    if (this.entries.has(key)) return false;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, expiresAt);
    return true;
  }

  prune(now: number): number {
    let removed = 0;
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number { return this.entries.size; }
}

/**
 * Versioned HMAC signing and replay verification for webhook receivers.
 *
 * The signed message includes a domain, key id, timestamp, nonce, and exact
 * body bytes. Key activation/expiry is checked before nonce consumption, and
 * the nonce is claimed only after a constant-time signature comparison so an
 * attacker cannot burn replay slots with invalid guesses.
 */
export class SignedWebhookSecurity {
  private readonly keys = new Map<string, SigningKey>();
  private readonly tolerance: number;
  private readonly nonceTtl: number;
  private readonly nonces: NonceStore;

  constructor(options: {
    keys: readonly SigningKey[];
    timestampToleranceSeconds?: number;
    nonceTtlSeconds?: number;
    nonceStore?: NonceStore;
  }) {
    if (options.keys.length === 0 || options.keys.length > MAX_SIGNING_KEYS) {
      throw new Error(`one to ${MAX_SIGNING_KEYS} signing keys are required`);
    }
    this.tolerance = positive(options.timestampToleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS);
    this.nonceTtl = positive(options.nonceTtlSeconds ?? DEFAULT_NONCE_TTL_SECONDS);
    this.nonces = options.nonceStore ?? new InMemoryNonceStore();
    for (const key of options.keys) this.addKey(key);
  }

  addKey(key: SigningKey): void {
    if (!key.id || key.id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(key.id)) throw new Error("invalid signing key id");
    if (key.secret.length < 16) throw new Error("signing key must be at least 16 bytes");
    if (!Number.isSafeInteger(key.activeFrom) || key.activeFrom < 0) throw new Error("invalid key activation time");
    if (key.expiresAt !== undefined && key.expiresAt <= key.activeFrom) throw new Error("key expiry must follow activation");
    this.keys.set(key.id, { ...key, secret: Buffer.from(key.secret) });
  }

  rotate(key: SigningKey): void {
    this.addKey(key);
  }

  removeKey(keyId: string): boolean {
    return this.keys.delete(keyId);
  }

  listKeys(): Array<{ id: string; activeFrom: number; expiresAt?: number }> {
    return [...this.keys.values()].map(({ id, activeFrom, expiresAt }) => ({
      id,
      activeFrom,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }));
  }

  sign(body: Buffer, now = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString("hex")): SignedWebhook {
    const key = this.activeKey(now);
    if (!key) throw new Error("no active signing key");
    const signature = this.digest(key, body, now, nonce);
    return {
      keyId: key.id,
      timestamp: now,
      nonce,
      signature,
      header: `v1=${key.id},t=${now},n=${nonce},s=${signature}`,
    };
  }

  verify(body: Buffer, header: string, now = Math.floor(Date.now() / 1000)): VerificationResult {
    const parsed = parseHeader(header);
    if (!parsed) return { ok: false, reason: "malformed" };
    const key = this.keys.get(parsed.keyId);
    if (!key) return { ok: false, reason: "unknown_key" };
    if (now < key.activeFrom || (key.expiresAt !== undefined && now >= key.expiresAt)) {
      return { ok: false, reason: "key_not_active" };
    }
    if (Math.abs(now - parsed.timestamp) > this.tolerance) return { ok: false, reason: "timestamp_out_of_range" };
    const expected = Buffer.from(this.digest(key, body, parsed.timestamp, parsed.nonce), "hex");
    const actual = Buffer.from(parsed.signature, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { ok: false, reason: "invalid_signature" };
    }
    if (!this.nonces.claim(key.id, parsed.nonce, now + this.nonceTtl, now)) {
      return { ok: false, reason: "nonce_replayed" };
    }
    return { ok: true, keyId: key.id, timestamp: parsed.timestamp, nonce: parsed.nonce };
  }

  get nonceCount(): number { return this.nonces.size(); }

  private activeKey(now: number): SigningKey | undefined {
    return [...this.keys.values()]
      .filter((key) => now >= key.activeFrom && (key.expiresAt === undefined || now < key.expiresAt))
      .sort((a, b) => b.activeFrom - a.activeFrom)[0];
  }

  private digest(key: SigningKey, body: Buffer, timestamp: number, nonce: string): string {
    return createHmac("sha256", key.secret)
      .update("predictify-webhook-v1\n")
      .update(key.id)
      .update("\n")
      .update(String(timestamp))
      .update("\n")
      .update(nonce)
      .update("\n")
      .update(body)
      .digest("hex");
  }
}

function parseHeader(header: string): { keyId: string; timestamp: number; nonce: string; signature: string } | undefined {
  if (typeof header !== "string" || header.length > 512) return undefined;
  const parts = new Map(header.split(",").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index), part.slice(index + 1)];
  }));
  const keyId = parts.get("v1") === undefined ? "" : parts.get("v1") as string;
  const timestamp = Number(parts.get("t"));
  const nonce = parts.get("n") ?? "";
  const signature = parts.get("s") ?? "";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || !Number.isSafeInteger(timestamp) || timestamp < 0 ||
      !/^[a-f0-9]{8,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return undefined;
  return { keyId, timestamp, nonce, signature };
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("value must be a positive integer");
  return value;
}
