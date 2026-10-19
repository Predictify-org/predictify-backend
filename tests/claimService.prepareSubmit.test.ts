import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
    Account,
    Address,
    Keypair,
    Networks,
    SorobanDataBuilder,
    Transaction,
    TransactionBuilder,
    scValToNative,
    xdr,
} from "@stellar/stellar-sdk";
import { logger } from "../src/config/logger";
import {
    SimulatedClaimNonceSource,
    SorobanClaimChain,
    mapSendErrorCode,
    type ClaimNonceSource,
    type ClaimRpc,
} from "../src/services/claimChain";
import {
    ClaimError,
    prepareClaim,
    submitClaim,
    type ClaimContext,
    type ClaimDeps,
    type ClaimRecord,
    type ClaimRepo,
    type ClaimStatus,
    type NewPreparedClaim,
    type TransitionPatch,
} from "../src/services/claimService";

const CONTRACT_ID = "CCWRJXIUBSMFQ4AF2RXXH3AFBW6MEZG4GK4IYES7C4Z3X4PR6K7VAFHC";
const PASSPHRASE = Networks.TESTNET;
const MARKET = "mkt_5cae97f9_0";
const USER_ID = "00000000-0000-4000-8000-000000000001";

const wallet = Keypair.random();
const USER = wallet.publicKey();

// ── Fakes ──────────────────────────────────────────────────────────────────

function invokeOf(tx: Transaction) {
    const op = tx.operations[0];
    if (op.type !== "invokeHostFunction") throw new Error("not an invoke op");
    return op.func.invokeContract();
}

class FakeRpc implements ClaimRpc {
    simulated: Transaction[] = [];
    sent: Transaction[] = [];
    simulateError: string | null = null;
    /** When set, `get_claim_nonce` simulates to this value; otherwise it errors (slim build). */
    nonceValue: bigint | null = null;
    sendStatus = "PENDING";
    sendError: Error | null = null;
    sendErrorResult: xdr.TransactionResult | undefined;
    sendDelayMs = 0;

    async getAccount(address: string) {
        return new Account(address, "100");
    }

    async simulateTransaction(tx: Transaction) {
        this.simulated.push(tx);
        const fn = invokeOf(tx).functionName().toString();
        if (fn === "get_claim_nonce") {
            if (this.nonceValue === null) {
                return { id: "1", latestLedger: 1, events: [], _parsed: true, error: "no such function" };
            }
            return this.success(
                xdr.ScVal.scvU64(xdr.Uint64.fromString(this.nonceValue.toString())),
            );
        }
        if (this.simulateError) {
            return { id: "1", latestLedger: 1, events: [], _parsed: true, error: this.simulateError };
        }
        return this.success(xdr.ScVal.scvVoid());
    }

    private success(retval: xdr.ScVal) {
        return {
            id: "1",
            latestLedger: 1,
            events: [],
            _parsed: true,
            transactionData: new SorobanDataBuilder(),
            minResourceFee: "100",
            cost: { cpuInsns: "0", memBytes: "0" },
            result: { auth: [], retval },
        };
    }

    async sendTransaction(tx: Transaction) {
        this.sent.push(tx);
        if (this.sendDelayMs) await new Promise((r) => setTimeout(r, this.sendDelayMs));
        if (this.sendError) throw this.sendError;
        return {
            status: this.sendStatus,
            hash: tx.hash().toString("hex"),
            latestLedger: 1,
            latestLedgerCloseTime: 1,
            errorResult: this.sendErrorResult,
        };
    }
}

class MemoryClaimRepo implements ClaimRepo {
    rows: ClaimRecord[] = [];
    context: ClaimContext = {
        market: { status: "resolved" },
        prediction: {
            id: "pred-1",
            result: "won",
            amount: "100",
            claimTxHash: null,
            claimedAt: null,
        },
    };
    predictionClaims: Array<{ txHash: string }> = [];
    private seq = 0;

    async loadContext() {
        return this.context;
    }

    async findActiveClaim(userId: string, marketId: string) {
        return (
            this.rows.find(
                (r) =>
                    r.userId === userId &&
                    r.marketId === marketId &&
                    ["prepared", "submitting", "paid", "settled"].includes(r.status),
            ) ?? null
        );
    }

    async hasConsumedNonce(userId: string, marketId: string) {
        return this.rows.some(
            (r) =>
                r.userId === userId &&
                r.marketId === marketId &&
                ["paid", "settled"].includes(r.status),
        );
    }

    async insertPrepared(input: NewPreparedClaim) {
        // Mirrors the partial unique index on (user_id, market_id).
        if (
            this.rows.some(
                (r) =>
                    r.userId === input.userId &&
                    r.marketId === input.marketId &&
                    ["prepared", "submitting", "paid"].includes(r.status),
            )
        ) {
            return null;
        }
        const row: ClaimRecord = {
            id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
            ...input,
            status: "prepared",
            settlementTx: null,
            errorCode: null,
            createdAt: new Date(),
        };
        this.rows.push(row);
        return { ...row };
    }

    async findById(id: string) {
        const row = this.rows.find((r) => r.id === id);
        return row ? { ...row } : null;
    }

    async transition(id: string, from: ClaimStatus, to: ClaimStatus, patch: TransitionPatch = {}) {
        const row = this.rows.find((r) => r.id === id);
        if (!row || row.status !== from) return null;
        if (patch.notExpiredAt && !(row.expiresAt && row.expiresAt > patch.notExpiredAt)) {
            return null;
        }
        row.status = to;
        if (patch.settlementTx !== undefined) row.settlementTx = patch.settlementTx;
        if (patch.errorCode !== undefined) row.errorCode = patch.errorCode;
        return { ...row };
    }

    async recordPredictionClaim(_u: string, _m: string, txHash: string, claimedAt: Date) {
        this.predictionClaims.push({ txHash });
        if (this.context.prediction) {
            this.context.prediction.claimTxHash = txHash;
            this.context.prediction.claimedAt = claimedAt;
        }
    }
}

function setup(overrides: Partial<ClaimDeps> = {}) {
    const rpc = new FakeRpc();
    const repo = new MemoryClaimRepo();
    const chain = new SorobanClaimChain(rpc, CONTRACT_ID, PASSPHRASE);
    const nonceSource = new SimulatedClaimNonceSource(rpc, CONTRACT_ID, PASSPHRASE);
    const deps: ClaimDeps = { repo, chain, nonceSource, ...overrides };
    return { rpc, repo, deps };
}

function sign(xdrString: string, signer: Keypair = wallet): string {
    const tx = TransactionBuilder.fromXDR(xdrString, PASSPHRASE) as Transaction;
    tx.sign(signer);
    return tx.toXDR();
}

const prepareInput = { marketId: MARKET, userId: USER_ID, stellarAddress: USER };

async function prepared(deps: ClaimDeps) {
    return prepareClaim(prepareInput, deps);
}

function submitInput(claimId: string, signedXdr: string) {
    return { claimId, signedXdr, userId: USER_ID, stellarAddress: USER };
}

/** Builds a signed claim_winnings tx from scratch with arbitrary parameters. */
function forgeSigned(opts: {
    source?: string;
    contract?: string;
    fn?: string;
    market?: string;
    nonce?: bigint;
    signer?: Keypair;
}): string {
    const { Contract, nativeToScVal } = require("@stellar/stellar-sdk");
    const source = opts.source ?? USER;
    const tx = new TransactionBuilder(new Account(source, "100"), {
        fee: "100",
        networkPassphrase: PASSPHRASE,
    })
        .addOperation(
            new Contract(opts.contract ?? CONTRACT_ID).call(
                opts.fn ?? "claim_winnings",
                new Address(USER).toScVal(),
                nativeToScVal(opts.market ?? MARKET, { type: "symbol" }),
                nativeToScVal(opts.nonce ?? 0n, { type: "u64" }),
            ),
        )
        .setTimeout(300)
        .build();
    tx.sign(opts.signer ?? wallet);
    return tx.toXDR();
}

let loggerError: jest.SpyInstance;
beforeEach(() => {
    loggerError = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    jest.spyOn(logger, "info").mockImplementation(() => undefined);
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

async function expectClaimError(p: Promise<unknown>, status: number, code: string) {
    await expect(p).rejects.toMatchObject({ status, code });
    await p.catch((e) => expect(e).toBeInstanceOf(ClaimError));
}

// ── 1 ──────────────────────────────────────────────────────────────────────

describe("prepareClaim", () => {
    it("1: builds claim_winnings(user, Symbol(marketId), u64 0) with the user as source", async () => {
        const { rpc, repo, deps } = setup();
        const out = await prepared(deps);

        // The fake RPC saw the real call: name, argument types and values.
        const simulatedClaim = rpc.simulated.find(
            (t) => invokeOf(t).functionName().toString() === "claim_winnings",
        ) as Transaction;
        const args = invokeOf(simulatedClaim).args();
        expect(args.map((a) => a.switch().name)).toEqual(["scvAddress", "scvSymbol", "scvU64"]);

        // The returned XDR decodes to the same call.
        const tx = TransactionBuilder.fromXDR(out.xdr, PASSPHRASE) as Transaction;
        expect(tx.source).toBe(USER);
        expect(tx.signatures).toHaveLength(0);
        const invoke = invokeOf(tx);
        expect(invoke.functionName().toString()).toBe("claim_winnings");
        expect(Address.fromScAddress(invoke.contractAddress()).toString()).toBe(CONTRACT_ID);
        const [user, market, nonce] = invoke.args().map((a) => scValToNative(a));
        expect(user).toBe(USER);
        expect(market).toBe(MARKET);
        expect(nonce).toBe(0n);

        expect(out.networkPassphrase).toBe(PASSPHRASE);
        expect(out.claimId).toBe(repo.rows[0].id);
        expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now());
        expect(repo.rows[0]).toMatchObject({
            status: "prepared",
            claimNonce: "0",
            expectedTxHash: tx.hash().toString("hex"),
        });
    });

    it("2a: rejects an unresolved market and writes no claims row", async () => {
        const { repo, deps } = setup();
        repo.context.market = { status: "open" };
        await expectClaimError(prepared(deps), 400, "market_not_resolved");
        expect(repo.rows).toHaveLength(0);
    });

    it("2b: rejects a losing prediction and writes no claims row", async () => {
        const { repo, deps } = setup();
        repo.context.prediction!.result = "lost";
        await expectClaimError(prepared(deps), 400, "prediction_not_winning");
        expect(repo.rows).toHaveLength(0);
    });

    it("rejects an unknown market / missing prediction / already claimed prediction", async () => {
        const a = setup();
        a.repo.context.market = null;
        await expectClaimError(prepared(a.deps), 404, "market_not_found");

        const b = setup();
        b.repo.context.prediction = null;
        await expectClaimError(prepared(b.deps), 404, "prediction_not_found");

        const c = setup();
        c.repo.context.prediction!.claimTxHash = "abc";
        await expectClaimError(prepared(c.deps), 409, "claim_already_submitted");
    });

    it("2c: only confirmed predictions are claimable (ambiguous / unconfirmed)", async () => {
        const a = setup();
        a.repo.context = { ...a.repo.context, prediction: null, ambiguous: true };
        await expectClaimError(prepared(a.deps), 409, "ambiguous_prediction");
        expect(a.repo.rows).toHaveLength(0);

        const b = setup();
        b.repo.context = { ...b.repo.context, prediction: null, unconfirmedOnly: true };
        await expectClaimError(prepared(b.deps), 400, "prediction_not_winning");
        expect(b.repo.rows).toHaveLength(0);
    });

    it("7a: maps a simulation error to a stable code without leaking SDK text", async () => {
        const { rpc, repo, deps } = setup();
        rpc.simulateError = "HostError: secret internal detail";
        const err = await prepared(deps).catch((e) => e);

        expect(err).toBeInstanceOf(ClaimError);
        expect(err.code).toBe("claim_simulation_failed");
        expect(JSON.stringify({ message: err.message, code: err.code })).not.toMatch(
            /secret internal detail/,
        );
        // The full error is kept for structured logs.
        expect(loggerError).toHaveBeenCalledWith(
            expect.objectContaining({ code: "claim_simulation_failed" }),
            "claim: prepare failed",
        );
        expect(String(loggerError.mock.calls[0][0].err)).toMatch(/secret internal detail/);
        expect(repo.rows).toHaveLength(0);
    });

    it("8: a second prepare returns the existing prepared claim, never a second row", async () => {
        const { repo, deps } = setup();
        const first = await prepared(deps);
        const second = await prepared(deps);
        expect(second.claimId).toBe(first.claimId);
        expect(second.xdr).toBe(first.xdr);
        expect(repo.rows).toHaveLength(1);
    });

    it("8b: concurrent prepares converge on one claim", async () => {
        const { repo, deps } = setup();
        const [a, b] = await Promise.all([prepared(deps), prepared(deps)]);
        expect(a.claimId).toBe(b.claimId);
        expect(repo.rows).toHaveLength(1);
    });

    it("an expired prepared claim is expired and replaced by a fresh one", async () => {
        let now = new Date();
        const { repo, deps } = setup({ now: () => now });
        const first = await prepared(deps);
        now = new Date(now.getTime() + 10 * 60 * 1000);
        const second = await prepared(deps);
        expect(second.claimId).not.toBe(first.claimId);
        expect(repo.rows.find((r) => r.id === first.claimId)).toMatchObject({
            status: "expired",
            errorCode: "claim_expired",
        });
    });

    it("409s while a claim is submitting, and once it is paid", async () => {
        const { repo, deps } = setup();
        const out = await prepared(deps);
        repo.rows[0].status = "submitting";
        await expectClaimError(prepared(deps), 409, "claim_in_progress");
        repo.rows[0].status = "paid";
        await expectClaimError(prepared(deps), 409, "claim_already_submitted");
        expect(out.claimId).toBe(repo.rows[0].id);
    });

    it("uses the contract's get_claim_nonce when it is exported", async () => {
        const { rpc, repo, deps } = setup();
        repo.rows.push({
            id: "old",
            userId: USER_ID,
            marketId: MARKET,
            amount: "1",
            status: "settled",
            settlementTx: "x",
            claimNonce: "0",
            expectedTxHash: "x",
            preparedXdr: "x",
            expiresAt: new Date(),
            errorCode: null,
            createdAt: new Date(),
        });
        rpc.nonceValue = 7n;
        // A settled prior claim blocks a new prepare at the active-claim check,
        // so exercise the nonce source directly.
        await expect(
            deps.nonceSource.getClaimNonce({ user: USER, marketSymbol: MARKET, hasPriorClaim: true }),
        ).resolves.toBe(7n);
    });

    it("returns claim_nonce_unavailable when get_claim_nonce is missing and a prior claim exists", async () => {
        const { deps } = setup();
        await expectClaimError(
            deps.nonceSource.getClaimNonce({ user: USER, marketSymbol: MARKET, hasPriorClaim: true }),
            409,
            "claim_nonce_unavailable",
        );
    });

    it("accepts an injected ClaimNonceSource", async () => {
        const nonceSource: ClaimNonceSource = { getClaimNonce: jest.fn().mockResolvedValue(3n) };
        const { repo, deps } = setup({ nonceSource });
        await prepared(deps);
        expect(repo.rows[0].claimNonce).toBe("3");
        expect(nonceSource.getClaimNonce).toHaveBeenCalledWith({
            user: USER,
            marketSymbol: MARKET,
            hasPriorClaim: false,
        });
    });
});

// ── submit ─────────────────────────────────────────────────────────────────

describe("submitClaim", () => {
    it("3: relays a correctly signed prepared XDR and records paid + settlement_tx", async () => {
        const { rpc, repo, deps } = setup();
        const p = await prepared(deps);
        const signed = sign(p.xdr);

        const out = await submitClaim(submitInput(p.claimId, signed), deps);

        expect(rpc.sent).toHaveLength(1);
        expect(repo.rows[0].status).toBe("paid");
        expect(repo.rows[0].settlementTx).toBe(repo.rows[0].expectedTxHash);
        expect(out).toMatchObject({
            claimId: p.claimId,
            status: "paid",
            claimTxHash: repo.rows[0].expectedTxHash,
            predictionId: "pred-1",
        });
        expect(repo.predictionClaims).toHaveLength(1);
    });

    it("3b: DUPLICATE from the RPC also moves the claim to paid", async () => {
        const { rpc, repo, deps } = setup();
        rpc.sendStatus = "DUPLICATE";
        const p = await prepared(deps);
        await submitClaim(submitInput(p.claimId, sign(p.xdr)), deps);
        expect(repo.rows[0].status).toBe("paid");
    });

    describe("4: any deviation from the prepared tx is claim_xdr_mismatch and never reaches the RPC", () => {
        const cases: Array<[string, Parameters<typeof forgeSigned>[0]]> = [
            ["market_id", { market: "other_market" }],
            ["nonce", { nonce: 5n }],
            ["contract", { contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" }],
            ["source", { source: Keypair.random().publicKey() }],
            ["function name", { fn: "claim_winnings_batch" }],
        ];
        it.each(cases)("%s", async (_name, forged) => {
            const { rpc, repo, deps } = setup();
            const p = await prepared(deps);
            await expectClaimError(
                submitClaim(submitInput(p.claimId, forgeSigned(forged)), deps),
                400,
                "claim_xdr_mismatch",
            );
            expect(rpc.sent).toHaveLength(0);
            expect(repo.rows[0].status).toBe("prepared");
        });

        it("an unsigned prepared XDR", async () => {
            const { rpc, deps } = setup();
            const p = await prepared(deps);
            await expectClaimError(
                submitClaim(submitInput(p.claimId, p.xdr), deps),
                400,
                "claim_xdr_mismatch",
            );
            expect(rpc.sent).toHaveLength(0);
        });

        it("a tx identical in every field but with a different hash (fee)", async () => {
            const { rpc, deps } = setup();
            const p = await prepared(deps);
            const tx = TransactionBuilder.fromXDR(p.xdr, PASSPHRASE) as Transaction;
            const tampered = TransactionBuilder.cloneFrom(tx, {
                fee: "99999999",
                networkPassphrase: PASSPHRASE,
            }).build();
            tampered.sign(wallet);
            await expectClaimError(
                submitClaim(submitInput(p.claimId, tampered.toXDR()), deps),
                400,
                "claim_xdr_mismatch",
            );
            expect(rpc.sent).toHaveLength(0);
        });

        it("garbage XDR", async () => {
            const { rpc, deps } = setup();
            const p = await prepared(deps);
            await expectClaimError(
                submitClaim(submitInput(p.claimId, "AAAAAAAA"), deps),
                400,
                "claim_xdr_mismatch",
            );
            expect(rpc.sent).toHaveLength(0);
        });

        it("a tx for a different network passphrase", async () => {
            const { rpc, deps } = setup();
            const p = await prepared(deps);
            const tx = TransactionBuilder.fromXDR(p.xdr, PASSPHRASE) as Transaction;
            const other = TransactionBuilder.cloneFrom(tx, {
                networkPassphrase: Networks.PUBLIC,
                fee: tx.fee,
            }).build();
            other.sign(wallet);
            await expectClaimError(
                submitClaim(submitInput(p.claimId, other.toXDR()), deps),
                400,
                "claim_xdr_mismatch",
            );
            expect(rpc.sent).toHaveLength(0);
        });

        it("a fee-bump wrapper is unwrapped and its inner tx verified", async () => {
            const { rpc, repo, deps } = setup();
            const p = await prepared(deps);
            const inner = TransactionBuilder.fromXDR(sign(p.xdr), PASSPHRASE) as Transaction;
            const sponsor = Keypair.random();
            const bump = TransactionBuilder.buildFeeBumpTransaction(
                sponsor,
                "1000000",
                inner,
                PASSPHRASE,
            );
            bump.sign(sponsor);
            await submitClaim(submitInput(p.claimId, bump.toXDR()), deps);
            expect(rpc.sent).toHaveLength(1);
            expect(repo.rows[0].status).toBe("paid");
        });
    });

    it("5: concurrent submits of one claim hit the RPC exactly once", async () => {
        const { rpc, repo, deps } = setup();
        rpc.sendDelayMs = 20;
        const p = await prepared(deps);
        const signed = sign(p.xdr);

        const results = await Promise.allSettled([
            submitClaim(submitInput(p.claimId, signed), deps),
            submitClaim(submitInput(p.claimId, signed), deps),
            submitClaim(submitInput(p.claimId, signed), deps),
        ]);

        expect(rpc.sent).toHaveLength(1);
        expect(repo.rows).toHaveLength(1);
        expect(repo.rows[0].status).toBe("paid");
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        expect(fulfilled.length).toBeGreaterThanOrEqual(1);
        for (const r of results) {
            if (r.status === "rejected") {
                expect(r.reason).toMatchObject({ status: 409, code: "claim_in_progress" });
            }
        }
    });

    it("6: submitting after expiresAt is 409 claim_expired and skips the RPC", async () => {
        let now = new Date();
        const { rpc, repo, deps } = setup({ now: () => now });
        const p = await prepared(deps);
        const signed = sign(p.xdr);
        now = new Date(new Date(p.expiresAt).getTime() + 1000);

        await expectClaimError(
            submitClaim(submitInput(p.claimId, signed), deps),
            409,
            "claim_expired",
        );
        expect(rpc.sent).toHaveLength(0);
        expect(repo.rows[0]).toMatchObject({ status: "expired", errorCode: "claim_expired" });

        // Replaying an expired claim stays a 409.
        await expectClaimError(
            submitClaim(submitInput(p.claimId, signed), deps),
            409,
            "claim_expired",
        );
    });

    it("7b: RPC ERROR status fails the claim with a stable code and no SDK text", async () => {
        const { rpc, repo, deps } = setup();
        rpc.sendStatus = "ERROR";
        const p = await prepared(deps);
        const err = await submitClaim(submitInput(p.claimId, sign(p.xdr)), deps).catch((e) => e);

        expect(err).toBeInstanceOf(ClaimError);
        expect(err).toMatchObject({ status: 422, code: "claim_rejected" });
        expect(repo.rows[0]).toMatchObject({ status: "failed", errorCode: "claim_rejected" });
        expect(loggerError).toHaveBeenCalledWith(
            expect.objectContaining({ claimId: p.claimId, rpcStatus: "ERROR" }),
            "claim: transaction rejected by network",
        );

        // A failed claim is final: replays are 409.
        await expectClaimError(
            submitClaim(submitInput(p.claimId, sign(p.xdr)), deps),
            409,
            "claim_rejected",
        );
        // …and the user can prepare a fresh one.
        rpc.sendStatus = "PENDING";
        const again = await prepared(deps);
        expect(again.claimId).not.toBe(p.claimId);
    });

    it("maps a txTooLate RPC error to claim_expired", async () => {
        const { rpc, repo, deps } = setup();
        rpc.sendStatus = "ERROR";
        rpc.sendErrorResult = new xdr.TransactionResult({
            feeCharged: xdr.Int64.fromString("100"),
            result: xdr.TransactionResultResult.txTooLate(),
            ext: new xdr.TransactionResultExt(0),
        });
        const p = await prepared(deps);
        await expectClaimError(
            submitClaim(submitInput(p.claimId, sign(p.xdr)), deps),
            409,
            "claim_expired",
        );
        expect(repo.rows[0].errorCode).toBe("claim_expired");
    });

    it("an RPC exception returns the claim to prepared and is a retryable 503", async () => {
        const { rpc, repo, deps } = setup();
        rpc.sendError = new Error("socket hang up: internal-host:1234");
        const p = await prepared(deps);
        const signed = sign(p.xdr);
        const err = await submitClaim(submitInput(p.claimId, signed), deps).catch((e) => e);

        expect(err).toMatchObject({ status: 503, code: "claim_rpc_unavailable" });
        expect(err.message).not.toMatch(/internal-host/);
        expect(repo.rows[0].status).toBe("prepared");

        rpc.sendError = null;
        await submitClaim(submitInput(p.claimId, signed), deps);
        expect(repo.rows[0].status).toBe("paid");
    });

    it("TRY_AGAIN_LATER returns the claim to prepared", async () => {
        const { rpc, repo, deps } = setup();
        rpc.sendStatus = "TRY_AGAIN_LATER";
        const p = await prepared(deps);
        await expectClaimError(
            submitClaim(submitInput(p.claimId, sign(p.xdr)), deps),
            503,
            "claim_rpc_unavailable",
        );
        expect(repo.rows[0].status).toBe("prepared");
    });

    it("9: replaying a submit for a paid claim returns the stored result with the same settlement_tx", async () => {
        const { rpc, deps } = setup();
        const p = await prepared(deps);
        const signed = sign(p.xdr);
        const first = await submitClaim(submitInput(p.claimId, signed), deps);
        const replay = await submitClaim(submitInput(p.claimId, signed), deps);
        expect(replay.claimTxHash).toBe(first.claimTxHash);
        expect(replay.status).toBe("paid");
        expect(rpc.sent).toHaveLength(1);
    });

    it("404s for an unknown claim or someone else's claim", async () => {
        const { deps } = setup();
        const p = await prepared(deps);
        await expectClaimError(
            submitClaim(submitInput("00000000-0000-4000-8000-0000000000ff", sign(p.xdr)), deps),
            404,
            "claim_not_found",
        );
        await expectClaimError(
            submitClaim(
                { ...submitInput(p.claimId, sign(p.xdr)), userId: "00000000-0000-4000-8000-0000000000aa" },
                deps,
            ),
            404,
            "claim_not_found",
        );
    });

    it("a claim already moved to submitting by another request is 409 claim_in_progress", async () => {
        const { repo, deps } = setup();
        const p = await prepared(deps);
        repo.rows[0].status = "submitting";
        await expectClaimError(
            submitClaim(submitInput(p.claimId, sign(p.xdr)), deps),
            409,
            "claim_in_progress",
        );
    });

    it("a claim that expires between the check and the transition is claim_expired", async () => {
        const { rpc, repo, deps } = setup();
        const p = await prepared(deps);
        const signed = sign(p.xdr);
        // Expiry passes only once the conditional transition runs.
        const realTransition = repo.transition.bind(repo);
        jest.spyOn(repo, "transition").mockImplementation(async (id, from, to, patch) => {
            if (to === "submitting") repo.rows[0].expiresAt = new Date(Date.now() - 1000);
            return realTransition(id, from, to, patch);
        });
        await expectClaimError(
            submitClaim(submitInput(p.claimId, signed), deps),
            409,
            "claim_expired",
        );
        expect(rpc.sent).toHaveLength(0);
    });
});

describe("mapSendErrorCode", () => {
    it("defaults to claim_rejected for missing or undecodable results", () => {
        expect(mapSendErrorCode(undefined)).toBe("claim_rejected");
        expect(mapSendErrorCode("not-xdr")).toBe("claim_rejected");
    });
});

// ── 10 ─────────────────────────────────────────────────────────────────────

describe("10: the server never signs", () => {
    const claimModules = [
        "src/services/claimService.ts",
        "src/services/claimChain.ts",
        "src/services/claimErrors.ts",
        "src/services/claimRepo.ts",
    ];

    it.each(claimModules)("%s does not import Keypair or read a secret key", (file) => {
        const source = readFileSync(join(__dirname, "..", file), "utf8");
        expect(source).not.toMatch(/\bKeypair\b/);
        expect(source).not.toMatch(/fromSecret|SECRET/);
        expect(source).not.toMatch(/\.sign\(/);
    });

    it("the claim route module does not reference signing either", () => {
        const source = readFileSync(join(__dirname, "..", "src/routes/predictions.ts"), "utf8");
        expect(source).not.toMatch(/\bKeypair\b/);
    });

    it("covers every src/services/claim*.ts module", () => {
        const onDisk = readdirSync(join(__dirname, "..", "src/services"))
            .filter((f) => /^claim.*\.ts$/.test(f))
            .map((f) => `src/services/${f}`)
            .sort();
        expect(onDisk).toEqual([...claimModules].sort());
    });
});

// ── 11 ─────────────────────────────────────────────────────────────────────

describe("11: the settle-confirmer picks up claims written by submitClaim", () => {
    it("selects status = 'paid' rows with a settlement_tx, which is what a successful submit writes", async () => {
        const { drizzle } = await import("drizzle-orm/node-postgres");
        const { DrizzleSettleConfirmerRepo } = await import("../src/workers/settleConfirmer");

        // Paid row exactly as submitClaim leaves it.
        const { rpc, repo, deps } = setup();
        const p = await prepared(deps);
        await submitClaim(submitInput(p.claimId, sign(p.xdr)), deps);
        const paid = repo.rows[0];
        expect(paid.status).toBe("paid");
        expect(paid.settlementTx).toBeTruthy();
        expect(rpc.sent).toHaveLength(1);

        // Run the confirmer's real query through drizzle against a recording stub.
        const queries: Array<{ text: string; values: unknown[] }> = [];
        const client = {
            query: async (config: { text: string; values?: unknown[] } | string, values?: unknown[]) => {
                const text = typeof config === "string" ? config : config.text;
                queries.push({
                    text,
                    values: values ?? (typeof config === "string" ? [] : config.values) ?? [],
                });
                return {
                    rows: [[paid.id, paid.settlementTx, 0]],
                    rowCount: 1,
                    fields: [],
                    command: "SELECT",
                    oid: 0,
                };
            },
        };
        const confirmerRepo = new DrizzleSettleConfirmerRepo(drizzle(client as never));
        const pending = await confirmerRepo.getPendingSettlements(new Date());

        expect(pending).toEqual([{ id: paid.id, settlementTx: paid.settlementTx, settleAttempts: 0 }]);
        expect(queries).toHaveLength(1);
        expect(queries[0].text).toMatch(/from "claims"/);
        expect(queries[0].text).toMatch(/"status" = \$1/);
        expect(queries[0].values).toContain(paid.status);
    });
});
