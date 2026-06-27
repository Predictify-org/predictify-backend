/**
 * walletPrefs.test.ts
 *
 * Unit tests for app/state/walletPrefs.ts
 *
 * All tests use the injected `createMemoryStorage()` backend so they
 * never touch `localStorage` and run in any environment (Node, jsdom, etc.).
 *
 * Coverage areas
 * ──────────────
 *  1.  setLastUsedProvider – persists provider id and ISO timestamp
 *  2.  setLastUsedProvider – overwrites a previous value
 *  3.  getLastUsedProvider – returns null when storage is empty
 *  4.  getLastUsedProvider – returns the stored provider id
 *  5.  getLastUsedAt      – returns null when storage is empty
 *  6.  getLastUsedAt      – returns an ISO string after set
 *  7.  clearWalletPrefs   – removes the stored value
 *  8.  clearWalletPrefs   – is a no-op on already-empty storage
 *  9.  readPrefs          – returns defaults when storage is null (SSR)
 *  10. readPrefs          – returns defaults for malformed JSON
 *  11. readPrefs          – returns defaults for unexpected JSON shape
 *  12. readPrefs          – tolerates missing individual fields gracefully
 *  13. writePrefs         – is a no-op when storage is null (SSR)
 *  14. setLastUsedProvider– is a no-op when storage is null (SSR)
 *  15. getLastUsedProvider– returns null when storage is null (SSR)
 *  16. All six WalletProviderId values are accepted without type error
 *  17. WALLET_PREFS_KEY   – has expected value (regression guard)
 */

import {
  setLastUsedProvider,
  getLastUsedProvider,
  getLastUsedAt,
  clearWalletPrefs,
  readPrefs,
  writePrefs,
  createMemoryStorage,
  WALLET_PREFS_KEY,
  type WalletProviderId,
} from "./walletPrefs";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Creates a fresh memory store for each test. */
function store() {
  return createMemoryStorage();
}

// ── 1. setLastUsedProvider persists data ──────────────────────────────────

describe("setLastUsedProvider()", () => {
  it("persists the provider id to storage", () => {
    const s = store();
    setLastUsedProvider("freighter", s);
    expect(getLastUsedProvider(s)).toBe("freighter");
  });

  it("persists a valid ISO-8601 timestamp", () => {
    const before = Date.now();
    const s = store();
    setLastUsedProvider("albedo", s);
    const at = getLastUsedAt(s);
    expect(at).not.toBeNull();
    const parsed = new Date(at!).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());
  });

  it("overwrites a previous value", () => {
    const s = store();
    setLastUsedProvider("freighter", s);
    setLastUsedProvider("lobstr", s);
    expect(getLastUsedProvider(s)).toBe("lobstr");
  });

  it("accepts all six supported provider ids without error", () => {
    const providers: WalletProviderId[] = [
      "freighter",
      "albedo",
      "xbull",
      "rabet",
      "lobstr",
      "walletconnect",
    ];
    const s = store();
    for (const id of providers) {
      expect(() => setLastUsedProvider(id, s)).not.toThrow();
      expect(getLastUsedProvider(s)).toBe(id);
    }
  });
});

// ── 3–6. Getters ──────────────────────────────────────────────────────────

describe("getLastUsedProvider()", () => {
  it("returns null when storage is empty", () => {
    expect(getLastUsedProvider(store())).toBeNull();
  });

  it("returns the stored provider id", () => {
    const s = store();
    setLastUsedProvider("xbull", s);
    expect(getLastUsedProvider(s)).toBe("xbull");
  });
});

describe("getLastUsedAt()", () => {
  it("returns null when storage is empty", () => {
    expect(getLastUsedAt(store())).toBeNull();
  });

  it("returns a non-null string after a provider is set", () => {
    const s = store();
    setLastUsedProvider("rabet", s);
    expect(typeof getLastUsedAt(s)).toBe("string");
  });
});

// ── 7–8. clearWalletPrefs ────────────────────────────────────────────────

describe("clearWalletPrefs()", () => {
  it("removes the stored value so subsequent reads return defaults", () => {
    const s = store();
    setLastUsedProvider("lobstr", s);
    clearWalletPrefs(s);
    expect(getLastUsedProvider(s)).toBeNull();
    expect(getLastUsedAt(s)).toBeNull();
  });

  it("is a no-op on already-empty storage (no throw)", () => {
    const s = store();
    expect(() => clearWalletPrefs(s)).not.toThrow();
    expect(getLastUsedProvider(s)).toBeNull();
  });
});

// ── 9–12. readPrefs edge cases ───────────────────────────────────────────

describe("readPrefs()", () => {
  it("returns defaults when storage is null (SSR environment)", () => {
    const prefs = readPrefs(null);
    expect(prefs.lastUsedProvider).toBeNull();
    expect(prefs.lastUsedAt).toBeNull();
  });

  it("returns defaults when stored value is malformed JSON", () => {
    const s = store();
    s.setItem(WALLET_PREFS_KEY, "{ not valid json ~~~");
    const prefs = readPrefs(s);
    expect(prefs.lastUsedProvider).toBeNull();
    expect(prefs.lastUsedAt).toBeNull();
  });

  it("returns defaults when stored value is a JSON array (wrong shape)", () => {
    const s = store();
    s.setItem(WALLET_PREFS_KEY, JSON.stringify(["freighter"]));
    const prefs = readPrefs(s);
    expect(prefs.lastUsedProvider).toBeNull();
  });

  it("returns defaults when stored value is a JSON primitive", () => {
    const s = store();
    s.setItem(WALLET_PREFS_KEY, JSON.stringify(42));
    const prefs = readPrefs(s);
    expect(prefs.lastUsedProvider).toBeNull();
  });

  it("tolerates missing lastUsedAt field — falls back to null", () => {
    const s = store();
    s.setItem(
      WALLET_PREFS_KEY,
      JSON.stringify({ lastUsedProvider: "freighter" }),
    );
    const prefs = readPrefs(s);
    expect(prefs.lastUsedProvider).toBe("freighter");
    expect(prefs.lastUsedAt).toBeNull();
  });

  it("tolerates missing lastUsedProvider field — falls back to null", () => {
    const s = store();
    s.setItem(
      WALLET_PREFS_KEY,
      JSON.stringify({ lastUsedAt: "2024-01-01T00:00:00.000Z" }),
    );
    const prefs = readPrefs(s);
    expect(prefs.lastUsedProvider).toBeNull();
    expect(prefs.lastUsedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("returns a fresh object each call (mutation isolation)", () => {
    const s = store();
    setLastUsedProvider("freighter", s);
    const a = readPrefs(s);
    const b = readPrefs(s);
    expect(a).not.toBe(b); // different object references
    expect(a).toEqual(b);  // same content
  });
});

// ── 13–15. SSR / null-storage no-ops ─────────────────────────────────────

describe("null storage (SSR / unavailable localStorage)", () => {
  it("writePrefs() is a no-op — no throw", () => {
    expect(() =>
      writePrefs({ lastUsedProvider: "freighter", lastUsedAt: null }, null),
    ).not.toThrow();
  });

  it("setLastUsedProvider() is a no-op — no throw", () => {
    expect(() => setLastUsedProvider("freighter", null)).not.toThrow();
  });

  it("getLastUsedProvider() returns null", () => {
    expect(getLastUsedProvider(null)).toBeNull();
  });

  it("clearWalletPrefs() is a no-op — no throw", () => {
    expect(() => clearWalletPrefs(null)).not.toThrow();
  });
});

// ── 17. WALLET_PREFS_KEY regression guard ────────────────────────────────

describe("WALLET_PREFS_KEY", () => {
  it("has the expected stable value", () => {
    expect(WALLET_PREFS_KEY).toBe("predictify.walletPrefs");
  });
});

// ── createMemoryStorage ───────────────────────────────────────────────────

describe("createMemoryStorage()", () => {
  it("getItem returns null for unknown key", () => {
    expect(store().getItem("unknown")).toBeNull();
  });

  it("setItem / getItem round-trips a value", () => {
    const s = store();
    s.setItem("k", "v");
    expect(s.getItem("k")).toBe("v");
  });

  it("removeItem deletes the key", () => {
    const s = store();
    s.setItem("k", "v");
    s.removeItem("k");
    expect(s.getItem("k")).toBeNull();
  });

  it("each call returns an independent store", () => {
    const s1 = store();
    const s2 = store();
    s1.setItem("k", "s1");
    expect(s2.getItem("k")).toBeNull();
  });
});
