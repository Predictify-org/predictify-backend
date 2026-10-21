/**
 * claimService.ts
 *
 * User-signed claim flow for winning predictions.
 *
 * `claim_winnings(user, market_id, claim_nonce)` calls `user.require_auth()`,
 * so the server can never submit a claim on its own. The flow is two steps:
 *
 *  1. prepare — validate the market / prediction, resolve `claim_nonce`, build
 *     and simulate an unsigned transaction whose source is the user, and store
 *     it as a `claims` row (`status = "prepared"`) with its expected hash.
 *  2. submit  — accept the wallet-signed XDR, verify it is exactly the
 *     prepared transaction, then relay it and record the result.
 *
 * State machine (`claims.status`)
 * -------------------------------
 *   prepared ──► submitting ──► paid ──► settled | rejected  (settle-confirmer)
 *      │              │
 *      │              └──► failed      (RPC ERROR)
 *      └──► expired                     (submitted after expiresAt)
 *
 * Why hash equality is the authority: a wallet signature does not change a
 * transaction's hash, so `inner tx hash == prepared hash` proves the signed
 * envelope is byte-for-byte the transaction we simulated — same source,
 * contract, function, arguments, fee, footprint and time bounds. The
 * field-by-field checks in `ClaimChain.verifySigned` exist only to give clear
 * error codes.
 *
 * Concurrency: `prepared → submitting` is a conditional UPDATE
 * (`WHERE status = 'prepared'`), so concurrent submits of one claim cannot
 * both reach the RPC. A partial unique index allows at most one non-terminal
 * claim per (user, market).
 */

import { logger } from "../config/logger";
import { env } from "../config/env";
import { getRequestId } from "../lib/requestContext";
import { claimsPreparedTotal, claimsSubmittedTotal } from "../metrics/registry";
import {
    SimulatedClaimNonceSource,
    SorobanClaimChain,
    mapSendErrorCode,
    type ClaimChain,
    type ClaimNonceSource,
} from "./claimChain";
import { ClaimError } from "./claimErrors";

export { ClaimError } from "./claimErrors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaimStatus =
    | "prepared"
    | "submitting"
    | "paid"
    | "failed"
    | "expired"
    | "settled"
    | "rejected";

export interface ClaimRecord {
    id: string;
    userId: string;
    marketId: string;
    amount: string;
    status: ClaimStatus;
    settlementTx: string | null;
    claimNonce: string | null;
    expectedTxHash: string | null;
    preparedXdr: string | null;
    expiresAt: Date | null;
    errorCode: string | null;
    createdAt: Date;
}

export interface ClaimContext {
    market: { status: string } | null;
    /** The user's single confirmed prediction for the market, if exactly one exists. */
    prediction: {
        id: string;
        result: string | null;
        amount: string;
        claimTxHash: string | null;
        claimedAt: Date | null;
    } | null;
    /** More than one confirmed prediction exists for this user and market. */
    ambiguous?: boolean;
    /** Predictions exist but none is confirmed (pending / failed). */
    unconfirmedOnly?: boolean;
}

export interface NewPreparedClaim {
    userId: string;
    marketId: string;
    amount: string;
    claimNonce: string;
    expectedTxHash: string;
    preparedXdr: string;
    expiresAt: Date;
}

export interface TransitionPatch {
    settlementTx?: string;
    errorCode?: string;
    /** Only transition while `expiresAt` is still in the future. */
    notExpiredAt?: Date;
}

/** Persistence port — a Drizzle implementation lives in `claimRepo.ts`. */
export interface ClaimRepo {
    loadContext(marketId: string, userId: string): Promise<ClaimContext>;
    /** The user's non-failed claim for the market (prepared / submitting / paid / settled). */
    findActiveClaim(userId: string, marketId: string): Promise<ClaimRecord | null>;
    /** True if a paid / settled claim exists, i.e. a nonce may have been consumed on-chain. */
    hasConsumedNonce(userId: string, marketId: string): Promise<boolean>;
    /** Inserts a prepared claim; returns null when the one-active-claim index rejects it. */
    insertPrepared(input: NewPreparedClaim): Promise<ClaimRecord | null>;
    findById(id: string): Promise<ClaimRecord | null>;
    /** Atomic `UPDATE … WHERE id AND status = from`; returns null if the row was not in `from`. */
    transition(
        id: string,
        from: ClaimStatus,
        to: ClaimStatus,
        patch?: TransitionPatch,
    ): Promise<ClaimRecord | null>;
    recordPredictionClaim(
        userId: string,
        marketId: string,
        txHash: string,
        claimedAt: Date,
    ): Promise<void>;
}

export interface ClaimDeps {
    repo: ClaimRepo;
    chain: ClaimChain;
    nonceSource: ClaimNonceSource;
    now?: () => Date;
}

export interface PrepareClaimInput {
    /** On-chain market id; must be a valid Soroban Symbol. */
    marketId: string;
    userId: string;
    /** Stellar G-address of the authenticated user. */
    stellarAddress: string;
}

export interface PrepareClaimResult {
    claimId: string;
    xdr: string;
    networkPassphrase: string;
    expiresAt: string;
}

export interface SubmitClaimInput {
    claimId: string;
    userId: string;
    stellarAddress: string;
    signedXdr: string;
}

export interface SubmitClaimResult {
    claimId: string;
    status: string;
    predictionId: string | null;
    result: string | null;
    claimTxHash: string | null;
    claimedAt: string | null;
}

// ---------------------------------------------------------------------------
// Default dependencies
// ---------------------------------------------------------------------------

let defaultDeps: ClaimDeps | undefined;

async function getDefaultDeps(): Promise<ClaimDeps> {
    if (!defaultDeps) {
        const { rpc } = await import("@stellar/stellar-sdk");
        const { DrizzleClaimRepo } = await import("./claimRepo");
        const server = new rpc.Server(env.SOROBAN_RPC_URL, {
            allowHttp: env.SOROBAN_RPC_URL.startsWith("http://"),
        });
        defaultDeps = {
            repo: new DrizzleClaimRepo(),
            chain: new SorobanClaimChain(server),
            nonceSource: new SimulatedClaimNonceSource(server),
        };
    }
    return defaultDeps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logTransition(claim: ClaimRecord, from: ClaimStatus, extra?: Record<string, unknown>): void {
    logger.info(
        { reqId: getRequestId(), claimId: claim.id, from, to: claim.status, ...extra },
        "claim: state change",
    );
}

function preparedResult(claim: ClaimRecord, chain: ClaimChain): PrepareClaimResult {
    return {
        claimId: claim.id,
        xdr: claim.preparedXdr as string,
        networkPassphrase: chain.networkPassphrase,
        expiresAt: (claim.expiresAt as Date).toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

/**
 * Validates the claim and returns an unsigned, simulated `claim_winnings`
 * transaction for the user's wallet to sign.
 *
 * @throws {ClaimError} Business-rule violations and mapped chain failures.
 */
export async function prepareClaim(
    input: PrepareClaimInput,
    deps?: ClaimDeps,
): Promise<PrepareClaimResult> {
    const { repo, chain, nonceSource, now = () => new Date() } = deps ?? (await getDefaultDeps());
    const { marketId, userId, stellarAddress } = input;

    const { market, prediction, ambiguous, unconfirmedOnly } = await repo.loadContext(
        marketId,
        userId,
    );
    if (!market) throw new ClaimError(404, "market_not_found", "Market not found");
    if (market.status !== "resolved") {
        throw new ClaimError(
            400,
            "market_not_resolved",
            "Market must be resolved before claims can be processed",
        );
    }
    if (ambiguous) {
        throw new ClaimError(
            409,
            "ambiguous_prediction",
            "Multiple confirmed predictions found for this user and market",
        );
    }
    if (!prediction) {
        if (unconfirmedOnly) {
            throw new ClaimError(
                400,
                "prediction_not_winning",
                "No confirmed winning prediction found. Only confirmed winning predictions can be claimed",
            );
        }
        throw new ClaimError(
            404,
            "prediction_not_found",
            "No prediction found for this user and market",
        );
    }
    if (prediction.claimTxHash) {
        throw new ClaimError(
            409,
            "claim_already_submitted",
            "Winnings for this market have already been claimed",
        );
    }
    if (prediction.result !== "won") {
        throw new ClaimError(
            400,
            "prediction_not_winning",
            `Prediction result is "${prediction.result}". Only winning predictions can be claimed`,
        );
    }

    // At most one non-terminal claim per (user, market).
    const existing = await repo.findActiveClaim(userId, marketId);
    if (existing) {
        if (existing.status === "prepared") {
            if (existing.expiresAt && existing.expiresAt.getTime() > now().getTime()) {
                return preparedResult(existing, chain);
            }
            const expired = await repo.transition(existing.id, "prepared", "expired", {
                errorCode: "claim_expired",
            });
            if (expired) logTransition(expired, "prepared");
        } else if (existing.status === "submitting") {
            throw new ClaimError(409, "claim_in_progress", "A claim is already being submitted");
        } else {
            throw new ClaimError(
                409,
                "claim_already_submitted",
                "Winnings for this market have already been claimed",
            );
        }
    }

    const nonce = await nonceSource.getClaimNonce({
        user: stellarAddress,
        marketSymbol: marketId,
        hasPriorClaim: await repo.hasConsumedNonce(userId, marketId),
    });

    let prepared;
    try {
        prepared = await chain.prepare({ user: stellarAddress, marketSymbol: marketId, nonce });
    } catch (err) {
        if (err instanceof ClaimError) {
            logger.error(
                { reqId: getRequestId(), marketId, userId, code: err.code, err: err.detail ?? err },
                "claim: prepare failed",
            );
        }
        throw err;
    }

    const inserted = await repo.insertPrepared({
        userId,
        marketId,
        amount: prediction.amount,
        claimNonce: nonce.toString(),
        expectedTxHash: prepared.hash,
        preparedXdr: prepared.xdr,
        expiresAt: prepared.expiresAt,
    });
    if (!inserted) {
        // Lost a race with a concurrent prepare: hand back the winner's claim.
        const winner = await repo.findActiveClaim(userId, marketId);
        if (winner?.status === "prepared") return preparedResult(winner, chain);
        throw new ClaimError(409, "claim_in_progress", "A claim is already being submitted");
    }

    claimsPreparedTotal.inc();
    logger.info(
        { reqId: getRequestId(), claimId: inserted.id, marketId, userId, nonce: inserted.claimNonce },
        "claim: prepared",
    );
    return preparedResult(inserted, chain);
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function toSubmitResult(
    claim: ClaimRecord,
    deps: ClaimDeps,
): Promise<SubmitClaimResult> {
    const { prediction } = await deps.repo.loadContext(claim.marketId, claim.userId);
    return {
        claimId: claim.id,
        status: claim.status,
        predictionId: prediction?.id ?? null,
        result: prediction?.result ?? null,
        claimTxHash: claim.settlementTx,
        claimedAt: prediction?.claimedAt?.toISOString() ?? null,
    };
}

/** Maps a claim that cannot be submitted (again) to its stored result or a 409. */
async function resolveNonSubmittable(
    claim: ClaimRecord,
    deps: ClaimDeps,
): Promise<SubmitClaimResult> {
    switch (claim.status) {
        case "paid":
        case "settled":
            return toSubmitResult(claim, deps);
        case "expired":
            throw new ClaimError(409, "claim_expired", "Claim has expired; prepare a new one");
        case "failed":
        case "rejected":
            throw new ClaimError(
                409,
                claim.errorCode ?? "claim_rejected",
                "Claim was rejected; prepare a new one",
            );
        default:
            throw new ClaimError(409, "claim_in_progress", "Claim is already being submitted");
    }
}

/**
 * Verifies a wallet-signed claim transaction against the prepared one and
 * relays it to the network.
 *
 * @throws {ClaimError} Business-rule violations and mapped chain failures.
 */
export async function submitClaim(
    input: SubmitClaimInput,
    deps?: ClaimDeps,
): Promise<SubmitClaimResult> {
    const resolved = deps ?? (await getDefaultDeps());
    const { repo, chain, now = () => new Date() } = resolved;
    const { claimId, userId, stellarAddress, signedXdr } = input;

    const claim = await repo.findById(claimId);
    if (!claim || claim.userId !== userId) {
        throw new ClaimError(404, "claim_not_found", "Claim not found");
    }
    if (claim.status !== "prepared") return resolveNonSubmittable(claim, resolved);

    if (!claim.expiresAt || claim.expiresAt.getTime() <= now().getTime()) {
        const expired = await repo.transition(claim.id, "prepared", "expired", {
            errorCode: "claim_expired",
        });
        if (expired) {
            logTransition(expired, "prepared");
            claimsSubmittedTotal.inc({ outcome: "expired" });
        }
        throw new ClaimError(409, "claim_expired", "Claim has expired; prepare a new one");
    }

    try {
        chain.verifySigned(signedXdr, {
            user: stellarAddress,
            marketSymbol: claim.marketId,
            nonce: BigInt(claim.claimNonce ?? "0"),
            expectedTxHash: claim.expectedTxHash ?? "",
        });
    } catch (err) {
        claimsSubmittedTotal.inc({ outcome: "mismatch" });
        if (err instanceof ClaimError) {
            logger.warn(
                { reqId: getRequestId(), claimId, userId, reason: err.detail },
                "claim: signed XDR rejected",
            );
        }
        throw err;
    }

    // Only one concurrent submit can win this conditional transition.
    const submitting = await repo.transition(claim.id, "prepared", "submitting", {
        notExpiredAt: now(),
    });
    if (!submitting) {
        const current = await repo.findById(claim.id);
        if (current && current.status === "prepared") {
            throw new ClaimError(409, "claim_expired", "Claim has expired; prepare a new one");
        }
        return resolveNonSubmittable(current ?? claim, resolved);
    }
    logTransition(submitting, "prepared");

    let sent;
    try {
        sent = await chain.send(signedXdr);
    } catch (err) {
        // Outcome unknown. Re-submitting the same signed tx is safe (same hash,
        // same sequence number), so return the claim to `prepared`.
        logger.error(
            { reqId: getRequestId(), claimId, userId, err },
            "claim: sendTransaction threw",
        );
        const reverted = await repo.transition(claim.id, "submitting", "prepared");
        if (reverted) logTransition(reverted, "submitting");
        claimsSubmittedTotal.inc({ outcome: "error" });
        throw new ClaimError(503, "claim_rpc_unavailable", "Network unavailable; please retry");
    }

    if (sent.status === "PENDING" || sent.status === "DUPLICATE") {
        const paid = await repo.transition(claim.id, "submitting", "paid", {
            settlementTx: sent.hash,
        });
        const claimedAt = now();
        await repo.recordPredictionClaim(userId, claim.marketId, sent.hash, claimedAt);
        claimsSubmittedTotal.inc({ outcome: "paid" });
        if (paid) logTransition(paid, "submitting", { settlementTx: sent.hash });
        return toSubmitResult(paid ?? { ...submitting, status: "paid", settlementTx: sent.hash }, resolved);
    }

    if (sent.status === "TRY_AGAIN_LATER") {
        const reverted = await repo.transition(claim.id, "submitting", "prepared");
        if (reverted) logTransition(reverted, "submitting");
        claimsSubmittedTotal.inc({ outcome: "error" });
        throw new ClaimError(503, "claim_rpc_unavailable", "Network busy; please retry");
    }

    const code = mapSendErrorCode(sent.errorResultXdr);
    const failed = await repo.transition(claim.id, "submitting", "failed", { errorCode: code });
    logger.error(
        {
            reqId: getRequestId(),
            claimId,
            userId,
            rpcStatus: sent.status,
            errorResultXdr: sent.errorResultXdr,
        },
        "claim: transaction rejected by network",
    );
    if (failed) logTransition(failed, "submitting", { errorCode: code });
    claimsSubmittedTotal.inc({ outcome: "failed" });
    throw new ClaimError(
        code === "claim_expired" ? 409 : 422,
        code,
        code === "claim_expired"
            ? "Claim has expired; prepare a new one"
            : "Claim transaction was rejected by the network",
    );
}
