/**
 * claimErrors.ts
 *
 * Domain error for the claim flow. Messages are fixed, client-safe strings;
 * the underlying RPC / SDK error (if any) travels in `detail` so callers can
 * log it with the correlation id but never serialise it into a response.
 */

export type ClaimErrorCode =
    | "market_not_found"
    | "market_not_resolved"
    | "prediction_not_found"
    | "prediction_not_winning"
    | "claim_not_found"
    | "claim_already_submitted"
    | "claim_in_progress"
    | "claim_simulation_failed"
    | "claim_rejected"
    | "claim_expired"
    | "claim_xdr_mismatch"
    | "claim_nonce_unavailable"
    | "claim_rpc_unavailable";

/**
 * Thrown by the claim service for business-rule violations and mapped chain
 * failures. Caught by the route handler and translated into the standard
 * error envelope.
 */
export class ClaimError extends Error {
    public readonly status: number;
    public readonly code: string;
    /** Raw underlying error for structured logs only — never sent to clients. */
    public readonly detail?: unknown;

    constructor(status: number, code: string, message: string, detail?: unknown) {
        super(message);
        this.name = "ClaimError";
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}
