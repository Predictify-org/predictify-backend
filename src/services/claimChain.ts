/**
 * claimChain.ts
 *
 * Soroban side of the user-signed `claim_winnings` flow.
 *
 * The contract entrypoint is
 *   claim_winnings(user: Address, market_id: Symbol, claim_nonce: u64)
 * and it calls `user.require_auth()`, so only the user's wallet can authorise
 * it. This module therefore never signs anything: it builds and simulates an
 * unsigned transaction with the *user's* account as source, and later verifies
 * that a wallet-signed envelope is exactly that transaction before relaying it.
 *
 * No secret key is read anywhere in this module.
 */

import {
    Address,
    BASE_FEE,
    Contract,
    FeeBumpTransaction,
    Networks,
    Transaction,
    TransactionBuilder,
    nativeToScVal,
    rpc,
    scValToNative,
    xdr,
} from "@stellar/stellar-sdk";
import { env } from "../config/env";
import { ClaimError } from "./claimErrors";

export const CLAIM_FUNCTION = "claim_winnings";
export const GET_CLAIM_NONCE_FUNCTION = "get_claim_nonce";
/** How long a prepared transaction stays submittable. */
export const CLAIM_TTL_SECONDS = 300;

/** The subset of `rpc.Server` this module needs (eases faking in tests). */
export type ClaimRpc = Pick<
    rpc.Server,
    "getAccount" | "simulateTransaction" | "sendTransaction"
>;

export interface PreparedClaimTx {
    xdr: string;
    /** Hex hash of the unsigned transaction; a wallet signature does not change it. */
    hash: string;
    networkPassphrase: string;
    expiresAt: Date;
}

export interface ExpectedClaimTx {
    user: string;
    marketSymbol: string;
    nonce: bigint;
    expectedTxHash: string;
}

export interface SendResult {
    status: string;
    hash: string;
    /** Base64 TransactionResult for ERROR responses (logs / code mapping only). */
    errorResultXdr?: string;
}

export interface ClaimChain {
    readonly networkPassphrase: string;
    prepare(args: {
        user: string;
        marketSymbol: string;
        nonce: bigint;
    }): Promise<PreparedClaimTx>;
    /** Throws `claim_xdr_mismatch` unless `signedXdr` is exactly the prepared claim. */
    verifySigned(signedXdr: string, expected: ExpectedClaimTx): void;
    send(signedXdr: string): Promise<SendResult>;
}

export interface ClaimNonceSource {
    getClaimNonce(args: {
        user: string;
        marketSymbol: string;
        /** True when an earlier claim for this (user, market) may have consumed a nonce. */
        hasPriorClaim: boolean;
    }): Promise<bigint>;
}

export function resolveNetworkPassphrase(): string {
    return env.STELLAR_NETWORK === "testnet" ? Networks.TESTNET : Networks.PUBLIC;
}

function claimArgs(user: string, marketSymbol: string, nonce: bigint): xdr.ScVal[] {
    return [
        new Address(user).toScVal(),
        nativeToScVal(marketSymbol, { type: "symbol" }),
        nativeToScVal(nonce, { type: "u64" }),
    ];
}

export class SorobanClaimChain implements ClaimChain {
    readonly networkPassphrase: string;
    private readonly contract: Contract;

    constructor(
        private readonly server: ClaimRpc,
        contractId: string = env.PREDICTIFY_CONTRACT_ID,
        networkPassphrase: string = resolveNetworkPassphrase(),
    ) {
        this.contract = new Contract(contractId);
        this.networkPassphrase = networkPassphrase;
    }

    async prepare(args: {
        user: string;
        marketSymbol: string;
        nonce: bigint;
    }): Promise<PreparedClaimTx> {
        const { user, marketSymbol, nonce } = args;
        try {
            // The user — not the contract, not a server key — is the source.
            const account = await this.server.getAccount(user);
            const tx = new TransactionBuilder(account, {
                fee: BASE_FEE,
                networkPassphrase: this.networkPassphrase,
            })
                .addOperation(
                    this.contract.call(CLAIM_FUNCTION, ...claimArgs(user, marketSymbol, nonce)),
                )
                .setTimeout(CLAIM_TTL_SECONDS)
                .build();

            const sim = await this.server.simulateTransaction(tx);
            if (!rpc.Api.isSimulationSuccess(sim)) {
                throw new Error(
                    rpc.Api.isSimulationError(sim)
                        ? `simulation error: ${sim.error}`
                        : "simulation requires state restoration",
                );
            }

            const assembled = rpc.assembleTransaction(tx, sim).build();
            const maxTime = Number(assembled.timeBounds?.maxTime ?? 0);
            return {
                xdr: assembled.toXDR(),
                hash: assembled.hash().toString("hex"),
                networkPassphrase: this.networkPassphrase,
                expiresAt: new Date(maxTime * 1000),
            };
        } catch (err) {
            throw new ClaimError(
                422,
                "claim_simulation_failed",
                "Claim transaction could not be prepared",
                err,
            );
        }
    }

    verifySigned(signedXdr: string, expected: ExpectedClaimTx): void {
        const mismatch = (reason: string): ClaimError =>
            new ClaimError(
                400,
                "claim_xdr_mismatch",
                "Signed transaction does not match the prepared claim",
                reason,
            );

        let parsed: Transaction | FeeBumpTransaction;
        try {
            parsed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
        } catch (err) {
            throw new ClaimError(
                400,
                "claim_xdr_mismatch",
                "Signed transaction does not match the prepared claim",
                err,
            );
        }
        const tx: Transaction =
            parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;

        if (tx.source !== expected.user) throw mismatch("source account");
        if (tx.signatures.length === 0) throw mismatch("transaction is not signed");
        if (tx.operations.length !== 1) throw mismatch("operation count");

        const op = tx.operations[0];
        if (op.type !== "invokeHostFunction") throw mismatch("operation type");
        if (op.source !== undefined && op.source !== expected.user) {
            throw mismatch("operation source");
        }
        const fn = op.func;
        if (fn.switch().name !== "hostFunctionTypeInvokeContract") {
            throw mismatch("host function type");
        }
        const invoke = fn.invokeContract();
        if (Address.fromScAddress(invoke.contractAddress()).toString() !== this.contract.contractId()) {
            throw mismatch("contract id");
        }
        if (invoke.functionName().toString() !== CLAIM_FUNCTION) {
            throw mismatch("function name");
        }
        const args = invoke.args();
        if (args.length !== 3) throw mismatch("argument count");
        try {
            const [user, market, nonce] = args.map((a) => scValToNative(a));
            if (args[0].switch().name !== "scvAddress" || user !== expected.user) {
                throw mismatch("user argument");
            }
            if (args[1].switch().name !== "scvSymbol" || market !== expected.marketSymbol) {
                throw mismatch("market_id argument");
            }
            if (args[2].switch().name !== "scvU64" || BigInt(nonce) !== expected.nonce) {
                throw mismatch("claim_nonce argument");
            }
        } catch (err) {
            if (err instanceof ClaimError) throw err;
            throw mismatch("argument decoding");
        }

        // The authority: a wallet signature does not alter the transaction hash,
        // so the inner hash must equal the one computed at prepare time.
        if (tx.hash().toString("hex") !== expected.expectedTxHash) {
            throw mismatch("transaction hash");
        }
    }

    async send(signedXdr: string): Promise<SendResult> {
        const tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
        const resp = await this.server.sendTransaction(tx);
        return {
            status: resp.status,
            hash: resp.hash,
            errorResultXdr: resp.errorResult?.toXDR("base64"),
        };
    }
}

/**
 * Default nonce source: simulate `get_claim_nonce(user, market_id)` when the
 * deployed contract exports it (the slim testnet build does not). Otherwise
 * `0` is only correct for a first claim, so any earlier claim yields
 * `claim_nonce_unavailable` rather than a guess.
 */
export class SimulatedClaimNonceSource implements ClaimNonceSource {
    private readonly contract: Contract;

    constructor(
        private readonly server: ClaimRpc,
        contractId: string = env.PREDICTIFY_CONTRACT_ID,
        private readonly networkPassphrase: string = resolveNetworkPassphrase(),
    ) {
        this.contract = new Contract(contractId);
    }

    async getClaimNonce(args: {
        user: string;
        marketSymbol: string;
        hasPriorClaim: boolean;
    }): Promise<bigint> {
        const fromContract = await this.simulate(args.user, args.marketSymbol);
        if (fromContract !== null) return fromContract;
        if (!args.hasPriorClaim) return 0n;
        throw new ClaimError(
            409,
            "claim_nonce_unavailable",
            "Claim nonce could not be determined for this market",
        );
    }

    private async simulate(user: string, marketSymbol: string): Promise<bigint | null> {
        try {
            const account = await this.server.getAccount(user);
            const tx = new TransactionBuilder(account, {
                fee: BASE_FEE,
                networkPassphrase: this.networkPassphrase,
            })
                .addOperation(
                    this.contract.call(
                        GET_CLAIM_NONCE_FUNCTION,
                        new Address(user).toScVal(),
                        nativeToScVal(marketSymbol, { type: "symbol" }),
                    ),
                )
                .setTimeout(CLAIM_TTL_SECONDS)
                .build();
            const sim = await this.server.simulateTransaction(tx);
            if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;
            const value = scValToNative(sim.result.retval);
            return typeof value === "bigint" || typeof value === "number"
                ? BigInt(value)
                : null;
        } catch {
            return null;
        }
    }
}

/** Maps an RPC ERROR TransactionResult to a stable code (no SDK text). */
export function mapSendErrorCode(errorResultXdr: string | undefined): "claim_expired" | "claim_rejected" {
    if (!errorResultXdr) return "claim_rejected";
    try {
        const result = xdr.TransactionResult.fromXDR(errorResultXdr, "base64");
        return result.result().switch().name === "txTooLate" ? "claim_expired" : "claim_rejected";
    } catch {
        return "claim_rejected";
    }
}
