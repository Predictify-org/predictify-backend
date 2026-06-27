/**
 * walletPrefs.ts
 *
 * Persists lightweight wallet-connection preferences in `localStorage` so
 * the UI can show a "Last used" badge next to the provider the user most
 * recently connected with.
 *
 * ## Design goals
 *
 *   - Zero external dependencies — uses only the browser's `localStorage` API.
 *   - SSR-safe — all `localStorage` access is guarded so the module can be
 *     imported in a Next.js server-side context without throwing.
 *   - Tamper-tolerant — malformed or missing storage values are silently
 *     discarded and treated as if no preference was recorded.
 *   - Testable — all functions accept an optional `storage` parameter so tests
 *     can inject an in-memory store without monkey-patching globals.
 *
 * ## Storage schema
 *
 *   Key  : `predictify.walletPrefs`
 *   Value: JSON string matching the `WalletPrefs` interface below.
 *
 * ## Usage
 *
 * ```ts
 * import { setLastUsedProvider, getLastUsedProvider } from "@/state/walletPrefs";
 *
 * // After a successful connection:
 * setLastUsedProvider("freighter");
 *
 * // When rendering the provider list:
 * const lastUsed = getLastUsedProvider(); // "freighter" | null
 * ```
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** localStorage key under which preferences are stored. */
export const WALLET_PREFS_KEY = "predictify.walletPrefs";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Identifiers for the supported wallet providers.
 *
 * Extend this union as new providers are added — the rest of the module
 * is generic and requires no other changes.
 */
export type WalletProviderId =
  | "freighter"
  | "albedo"
  | "xbull"
  | "rabet"
  | "lobstr"
  | "walletconnect";

/** Shape of the persisted preferences object. */
export interface WalletPrefs {
  /**
   * ID of the provider the user last successfully connected with,
   * or `null` when no connection has been made yet.
   */
  lastUsedProvider: WalletProviderId | null;

  /** ISO-8601 timestamp of the last successful connection. */
  lastUsedAt: string | null;
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_PREFS: WalletPrefs = {
  lastUsedProvider: null,
  lastUsedAt: null,
};

// ── Storage abstraction ────────────────────────────────────────────────────

/**
 * A minimal interface satisfied by both `localStorage` and the in-memory
 * test double returned by `createMemoryStorage()`.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Returns the browser's `localStorage` when running in a browser context,
 * or `null` when running on the server (SSR / Node.js).
 *
 * Never throws.
 */
function getDefaultStorage(): StorageLike | null {
  try {
    // `typeof window` check prevents ReferenceError in SSR environments.
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // localStorage can throw in sandboxed iframes or private-browsing modes.
  }
  return null;
}

// ── Read / write helpers ───────────────────────────────────────────────────

/**
 * Read and parse the stored preferences.
 *
 * Returns `DEFAULT_PREFS` when:
 *   - `localStorage` is unavailable (SSR, sandbox)
 *   - The stored value is missing or cannot be parsed as JSON
 *   - The parsed object does not match the expected shape
 *
 * @param storage - Override the storage backend (useful in tests).
 */
export function readPrefs(storage?: StorageLike | null): WalletPrefs {
  const store = storage !== undefined ? storage : getDefaultStorage();
  if (!store) return { ...DEFAULT_PREFS };

  try {
    const raw = store.getItem(WALLET_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };

    const parsed = JSON.parse(raw) as unknown;

    // Validate shape — discard if malformed.
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const obj = parsed as Record<string, unknown>;
      const lastUsedProvider =
        typeof obj["lastUsedProvider"] === "string" ||
        obj["lastUsedProvider"] === null
          ? (obj["lastUsedProvider"] as WalletProviderId | null)
          : null;
      const lastUsedAt =
        typeof obj["lastUsedAt"] === "string" || obj["lastUsedAt"] === null
          ? (obj["lastUsedAt"] as string | null)
          : null;
      return { lastUsedProvider, lastUsedAt };
    }
  } catch {
    // JSON.parse failure — fall through to default.
  }

  return { ...DEFAULT_PREFS };
}

/**
 * Persist updated preferences to storage.
 *
 * Silently no-ops when `localStorage` is unavailable.
 *
 * @param prefs   - The preferences object to persist.
 * @param storage - Override the storage backend (useful in tests).
 */
export function writePrefs(
  prefs: WalletPrefs,
  storage?: StorageLike | null,
): void {
  const store = storage !== undefined ? storage : getDefaultStorage();
  if (!store) return;

  try {
    store.setItem(WALLET_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // setItem can throw when storage quota is exceeded — fail silently.
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Record that the user successfully connected with `providerId`.
 *
 * Persists `{ lastUsedProvider: providerId, lastUsedAt: <now ISO> }` to
 * `localStorage`.  Safe to call from an SSR context (no-op on the server).
 *
 * @param providerId - The wallet provider the user just connected with.
 * @param storage    - Override the storage backend (useful in tests).
 */
export function setLastUsedProvider(
  providerId: WalletProviderId,
  storage?: StorageLike | null,
): void {
  writePrefs(
    {
      lastUsedProvider: providerId,
      lastUsedAt: new Date().toISOString(),
    },
    storage,
  );
}

/**
 * Return the ID of the most recently used wallet provider, or `null` if
 * no connection has been recorded yet.
 *
 * @param storage - Override the storage backend (useful in tests).
 */
export function getLastUsedProvider(
  storage?: StorageLike | null,
): WalletProviderId | null {
  return readPrefs(storage).lastUsedProvider;
}

/**
 * Return the ISO-8601 timestamp of the last successful connection, or
 * `null` if no connection has been recorded yet.
 *
 * @param storage - Override the storage backend (useful in tests).
 */
export function getLastUsedAt(
  storage?: StorageLike | null,
): string | null {
  return readPrefs(storage).lastUsedAt;
}

/**
 * Remove all stored wallet preferences (e.g. on sign-out).
 *
 * @param storage - Override the storage backend (useful in tests).
 */
export function clearWalletPrefs(storage?: StorageLike | null): void {
  const store = storage !== undefined ? storage : getDefaultStorage();
  if (!store) return;
  try {
    store.removeItem(WALLET_PREFS_KEY);
  } catch {
    // Fail silently.
  }
}

// ── Test helpers ───────────────────────────────────────────────────────────

/**
 * Create a simple in-memory `StorageLike` for use in tests.
 *
 * ```ts
 * const storage = createMemoryStorage();
 * setLastUsedProvider("freighter", storage);
 * expect(getLastUsedProvider(storage)).toBe("freighter");
 * ```
 */
export function createMemoryStorage(): StorageLike {
  const data: Record<string, string> = {};
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
    removeItem: (key: string) => { delete data[key]; },
  };
}
