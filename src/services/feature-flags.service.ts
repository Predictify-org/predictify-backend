export interface FeatureFlagValue {
  enabled: boolean;
  metadata?: Record<string, unknown>;
}

export type FeatureFlagsResponse = Record<string, FeatureFlagValue>;

export class FeatureFlagsService {
  /**
   * Evaluates and returns feature flag states for the calling user/context.
   */
  public static getFlagsForUser(userAddress?: string): FeatureFlagsResponse {
    const isAuth = Boolean(userAddress);

    return {
      APPROVAL_WORKFLOW_ENABLED: {
        enabled: process.env.APPROVAL_WORKFLOW_ENABLED === 'true',
      },
      ENABLE_DOCS: {
        enabled: process.env.ENABLE_DOCS === 'true' || process.env.NODE_ENV !== 'production',
      },
      BETA_PREDICTION_MARKETS: {
        enabled: isAuth,
        metadata: { targetUser: userAddress ?? null },
      },
    };
  }
}
