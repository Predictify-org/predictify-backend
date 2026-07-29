/**
 * claimService.ts
 *
 * Handles the on-chain claim flow for winning predictions. After a market is
 * resolved, users call this endpoint to build, simulate, and submit a Soroban
 * claim transaction that transfers their winnings to their Stellar account.
 *
 * Architecture
 * ------------
 * The service is split into a public function (`claimWinnings`) and a
 * repository interface (`ClaimTxBuilder`) so that the Soroban RPC interaction
 * can be easily mocked in tests without a live network.
 *
 * Idempotency
 * -----------
 * If a prediction already has `claimTxHash` populated, the function returns the
 * existing data without making any on-chain calls. The HTTP-layer
 * Idempotency-Key middleware provides an additional safeguard against duplicate
 * submissions.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { markets, predictions } from "../db/schema";
import { env } from "../config/env";
import { logger } from "../config/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaimInput {
    /** Database UUID of the resolved market. */
    marketId: string;
    /** Database UUID of the authenticated user. */
    userId: string;
    /** Stellar G-address of the user (from JWT sub claim). */
    stellarAddress: string;
}

export interface ClaimResult {
    /** Prediction row id. */
    predictionId: string;
    /** "won" | "lost" | null */
    result: string | null;
    /** Soroban transaction hash, or null if the prediction was not a winner. */
    claimTxHash: string | null;
    /** ISO timestamp of when the claim was submitted (null if not claimed). */
    claimedAt: string | null;
}

/**
 * Interface for the Soroban transaction builder — extracted so tests can
 * provide a mock that never talks to a real RPC endpoint.
 */
export interface ClaimTxBuilder {
    /**
     * Builds, simulates, and submits a Soroban `claim(marketId, user)` call.
     *
     * @param marketId  On-chain market identifier (primary key in `markets`).
     * @param user      Stellar G-address of the user claiming.
     * @returns The on-chain transaction hash (hex-encoded string).
     */
    submitClaimTx(marketId: string, user: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `claimWinnings` for business-rule violations (e.g. market not
 * resolved, prediction not a winner). Caught by the route handler and
 * translated into the standard error envelope.
 */
export class ClaimError extends Error {
    public readonly status: number;
    public readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "ClaimError";
        this.status = status;
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// Main service function
// ---------------------------------------------------------------------------

/**
 * Claims winnings for a winning prediction after market resolution.
 *
 * Flow:
 *  1. Validate the market exists and is in "resolved" status.
 *  2. Look up the user's prediction for this market.
 *  3. If already claimed (claimTxHash is set) → return existing data.
 *  4. If the prediction result is not "won" → reject.
 *  5. Build & submit the Soroban claim transaction.
 *  6. Persist claimTxHash and claimedAt on the prediction row.
 *  7. Return the updated result.
 *
 * @throws {ClaimError}   When business rules are violated.
 * @throws {Error}        For unexpected failures (bubbles to global error handler).
 */
export async function claimWinnings(
    input: ClaimInput,
    txBuilder?: ClaimTxBuilder,
): Promise<ClaimResult> {
    const { marketId, userId, stellarAddress } = input;

    // Use the production builder if none was injected (DI for testability).
    const builder = txBuilder ?? new SorobanClaimTxBuilder();

    // ── 1. Validate market ────────────────────────────────────────────────
    const [market] = await db
        .select({ status: markets.status, winningOutcome: markets.winningOutcome })
        .from(markets)
        .where(eq(markets.id, marketId))
        .limit(1);

    if (!market) {
        throw new ClaimError(404, "market_not_found", "Market not found");
    }

    if (market.status !== "resolved") {
        throw new ClaimError(
            400,
            "market_not_resolved",
            "Market must be resolved before claims can be processed",
        );
    }

    // ── 2. Look up the user's prediction ──────────────────────────────────
    const [prediction] = await db
        .select({
            id: predictions.id,
            result: predictions.result,
            claimTxHash: predictions.claimTxHash,
            claimedAt: predictions.claimedAt,
        })
        .from(predictions)
        .where(
            and(
                eq(predictions.marketId, marketId),
                eq(predictions.userId, userId),
            ),
        )
        .limit(1);

    if (!prediction) {
        throw new ClaimError(
            404,
            "prediction_not_found",
            "No prediction found for this user and market",
        );
    }

    // ── 3. Already claimed → idempotent return ────────────────────────────
    if (prediction.claimTxHash) {
        logger.info(
            { marketId, userId, claimTxHash: prediction.claimTxHash },
            "claim: already claimed — returning existing data",
        );
        return {
            predictionId: prediction.id,
            result: prediction.result,
            claimTxHash: prediction.claimTxHash,
            claimedAt: prediction.claimedAt
                ? prediction.claimedAt.toISOString()
                : null,
        };
    }

    // ── 4. Validate prediction result ─────────────────────────────────────
    if (prediction.result !== "won") {
        throw new ClaimError(
            400,
            "prediction_not_winning",
            `Prediction result is "${prediction.result}". Only winning predictions can be claimed`,
        );
    }

    // ── 5. Submit Soroban claim transaction ───────────────────────────────
    let txHash: string;
    try {
        txHash = await builder.submitClaimTx(marketId, stellarAddress);
    } catch (err) {
        logger.error(
            { err, marketId, userId },
            "claim: Soroban transaction submission failed",
        );
        throw new ClaimError(
            500,
            "claim_tx_failed",
            `Failed to submit claim transaction: ${(err as Error).message}`,
        );
    }

    // ── 6. Persist claim tx hash ──────────────────────────────────────────
    const now = new Date();
    await db
        .update(predictions)
        .set({ claimTxHash: txHash, claimedAt: now })
        .where(eq(predictions.id, prediction.id));

    logger.info(
        { marketId, userId, claimTxHash: txHash },
        "claim: winnings claimed successfully",
    );

    return {
        predictionId: prediction.id,
        result: prediction.result,
        claimTxHash: txHash,
        claimedAt: now.toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Production Soroban transaction builder
// ---------------------------------------------------------------------------

/**
 * Builds and submits a Soroban claim transaction using `@stellar/stellar-sdk`.
 *
 * Under the hood:
 *  1. Connects to the configured Soroban-RPC endpoint.
 *  2. Constructs a `claim( marketId: string, user: address )` contract invocation.
 *  3. Simulates the transaction to obtain the footprint + fee.
 *  4. Assembles the final transaction and submits it.
 *
 * NOTE: In a production setting the signing key-pair would be managed by a
 * secure key-management service (e.g. HashiCorp Vault, AWS KMS). For this MVP
 * the server must be configured with a Stellar secret key that has sufficient
 * XLM balance to cover transaction fees.
 */
export class SorobanClaimTxBuilder implements ClaimTxBuilder {
    async submitClaimTx(marketId: string, user: string): Promise<string> {
        const { SorobanRpc, Contract, nativeToScVal, TransactionBuilder, Networks, BASE_FEE } = await import(
            "@stellar/stellar-sdk"
        );

        const server = new SorobanRpc.Server(env.SOROBAN_RPC_URL);
        const contract = new Contract(env.PREDICTIFY_CONTRACT_ID);

        // Build the Soroban invocation for claim(marketId, user).
        // The contract function is expected to be: `fn claim(market_id: String, user: Address)`
        const invocation = contract.call(
            "claim",
            nativeToScVal(marketId, { type: "string" }),
            nativeToScVal(user, { type: "address" }),
        );

        // ── Simulate the transaction ───────────────────────────────────────
        const account = await server.getAccount(env.PREDICTIFY_CONTRACT_ID);

        const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase:
                env.STELLAR_NETWORK === "testnet"
                    ? Networks.TESTNET
                    : Networks.PUBLIC,
        })
            .addOperation(invocation)
            .setTimeout(30)
            .build();

        const simulateResp = await server.simulateTransaction(tx);

        if (SorobanRpc.Api.isSimulationError(simulateResp)) {
            throw new Error(
                `Soroban simulation failed: ${simulateResp.error ?? "unknown error"}`,
            );
        }

        // ── Assemble & submit ──────────────────────────────────────────────
        // In production the fee-bump / signer key would come from a secure store.
        // Here we assume the server has a funded account for fees.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const preparedTx: any = SorobanRpc.assembleTransaction(tx, simulateResp);

        // Submit without additional signature (the contract account pays fees).
        // If a server-side signer is configured, sign here:
        //   const serverKeypair = Keypair.fromSecret(env.SERVER_SIGNER_SECRET);
        //   preparedTx.sign(serverKeypair);

        const sendResp = await server.sendTransaction(preparedTx);

        if (sendResp.status === "PENDING" || sendResp.status === "DUPLICATE") {
            return sendResp.hash;
        }

        throw new Error(
            `Soroban transaction rejected: ${sendResp.errorResult?.toString() ?? "unknown error"}`,
        );
    }
}

