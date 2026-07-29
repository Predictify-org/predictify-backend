/**
 * Feature-flag store.
 *
 * A lightweight in-process registry of feature flags used by the admin CRUD
 * endpoints. Flags are keyed by a stable, URL-safe `key`. The store is
 * deliberately simple (a Map) so the admin surface can be exercised without a
 * migration; it can later be swapped for a persisted table behind the same
 * interface without touching the route layer.
 */

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string | null;
  updatedAt: string;
}

export class FeatureFlagConflictError extends Error {
  status = 409;
  code = "feature_flag_exists";
  constructor(key: string) {
    super(`Feature flag '${key}' already exists`);
    Object.setPrototypeOf(this, FeatureFlagConflictError.prototype);
  }
}

export class FeatureFlagNotFoundError extends Error {
  status = 404;
  code = "not_found";
  constructor(key: string) {
    super(`Feature flag '${key}' not found`);
    Object.setPrototypeOf(this, FeatureFlagNotFoundError.prototype);
  }
}

const store = new Map<string, FeatureFlag>();

/** Test-only helper: wipe all flags so suites start from a clean slate. */
export function resetFeatureFlagsForTests(): void {
  store.clear();
}

export function listFeatureFlags(): FeatureFlag[] {
  return Array.from(store.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export function getFeatureFlag(key: string): FeatureFlag {
  const flag = store.get(key);
  if (!flag) {
    throw new FeatureFlagNotFoundError(key);
  }
  return flag;
}

export function createFeatureFlag(input: {
  key: string;
  enabled: boolean;
  description?: string | null;
}): FeatureFlag {
  if (store.has(input.key)) {
    throw new FeatureFlagConflictError(input.key);
  }
  const flag: FeatureFlag = {
    key: input.key,
    enabled: input.enabled,
    description: input.description ?? null,
    updatedAt: new Date().toISOString(),
  };
  store.set(flag.key, flag);
  return flag;
}

export function updateFeatureFlag(
  key: string,
  patch: { enabled?: boolean; description?: string | null },
): FeatureFlag {
  const existing = store.get(key);
  if (!existing) {
    throw new FeatureFlagNotFoundError(key);
  }
  const updated: FeatureFlag = {
    ...existing,
    enabled: patch.enabled ?? existing.enabled,
    description: patch.description !== undefined ? patch.description : existing.description,
    updatedAt: new Date().toISOString(),
  };
  store.set(key, updated);
  return updated;
}

export function deleteFeatureFlag(key: string): void {
  if (!store.delete(key)) {
    throw new FeatureFlagNotFoundError(key);
  }
}
