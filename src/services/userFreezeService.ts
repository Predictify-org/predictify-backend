/**
 * User-freeze registry.
 *
 * Tracks which Stellar addresses an admin has "frozen". A frozen user is
 * prevented from placing further bets/predictions (enforcement is expected at
 * the prediction-creation boundary via `isUserFrozen`). The store is a simple
 * in-process Map keyed by Stellar address so the admin surface works without a
 * schema migration; it can later be swapped for a persisted table behind the
 * same interface.
 */

export interface FreezeRecord {
  address: string;
  frozen: boolean;
  reason: string | null;
  /** Stellar address of the admin who last changed the freeze state. */
  updatedBy: string;
  updatedAt: string;
}

const store = new Map<string, FreezeRecord>();

/** Test-only helper: clear all freeze records. */
export function resetUserFreezeForTests(): void {
  store.clear();
}

/** Returns the freeze record for an address, or a default "not frozen" view. */
export function getFreezeStatus(address: string): FreezeRecord {
  return (
    store.get(address) ?? {
      address,
      frozen: false,
      reason: null,
      updatedBy: "",
      updatedAt: new Date(0).toISOString(),
    }
  );
}

/** True when the address is currently frozen and must not place bets. */
export function isUserFrozen(address: string): boolean {
  return store.get(address)?.frozen === true;
}

export function freezeUser(
  address: string,
  adminAddress: string,
  reason?: string | null,
): FreezeRecord {
  const record: FreezeRecord = {
    address,
    frozen: true,
    reason: reason ?? null,
    updatedBy: adminAddress,
    updatedAt: new Date().toISOString(),
  };
  store.set(address, record);
  return record;
}

export function unfreezeUser(address: string, adminAddress: string): FreezeRecord {
  const record: FreezeRecord = {
    address,
    frozen: false,
    reason: null,
    updatedBy: adminAddress,
    updatedAt: new Date().toISOString(),
  };
  store.set(address, record);
  return record;
}
