import { describe, expect, it } from "@jest/globals";
import {
  OUTBOX_EVENT_TYPES,
  OutboxError,
  SideEffectOutbox,
  enqueueNotification,
  enqueuePayout,
} from "../src/services/sideEffectOutbox";

const payout = { predictionId: "prediction-1", amount: 2500, currency: "XLM" };
const notification = { userId: "user-1", title: "Payout ready", body: "Your payout is ready" };

describe("transactional side-effect outbox", () => {
  it("commits a business side effect and its outbox event together", () => {
    const outbox = new SideEffectOutbox();
    outbox.transaction((transaction) => {
      transaction.putSideEffect("payout:payout-1", payout);
      transaction.enqueue("payout:payout-1", OUTBOX_EVENT_TYPES.PAYOUT, payout);
    }, () => 100);

    const event = outbox.getByKey("payout:payout-1");
    expect(event?.status).toBe("pending");
    expect(event?.attempts).toBe(0);
    expect(outbox.getSideEffect("payout:payout-1")).toEqual(payout);
  });

  it("does not leave an outbox record when the transaction callback fails", () => {
    const outbox = new SideEffectOutbox();
    expect(() => outbox.transaction((transaction) => {
      transaction.putSideEffect("notification:n-1", notification);
      transaction.enqueue("notification:n-1", OUTBOX_EVENT_TYPES.NOTIFICATION, notification);
      throw new Error("database constraint failed");
    })).toThrow("database constraint failed");
    expect(outbox.list()).toEqual([]);
    expect(outbox.getSideEffect("notification:n-1")).toBeUndefined();
  });

  it("deduplicates repeated payout and notification enqueue requests", () => {
    const outbox = new SideEffectOutbox();
    const firstPayout = enqueuePayout(outbox, "payout-1", payout);
    const secondPayout = enqueuePayout(outbox, "payout-1", { ...payout, amount: 9999 });
    const firstNotification = enqueueNotification(outbox, "notification-1", notification);
    const secondNotification = enqueueNotification(outbox, "notification-1", { ...notification, title: "changed" });
    expect(secondPayout).toEqual(firstPayout);
    expect(secondNotification).toEqual(firstNotification);
    expect(outbox.list()).toHaveLength(2);
    expect(outbox.getByKey("payout:payout-1")?.payload).toEqual(payout);
  });

  it("keeps the payload snapshot isolated from caller mutation", () => {
    const outbox = new SideEffectOutbox();
    const mutable = { nested: { amount: 1 } };
    outbox.enqueue("notification:isolated", OUTBOX_EVENT_TYPES.NOTIFICATION, mutable);
    mutable.nested.amount = 99;
    expect(outbox.getByKey("notification:isolated")?.payload).toEqual({ nested: { amount: 1 } });
  });
});

describe("outbox claiming and processing", () => {
  it("claims events in deterministic order and marks successful work complete", async () => {
    const claimOutbox = new SideEffectOutbox();
    claimOutbox.enqueue("notification:b", OUTBOX_EVENT_TYPES.NOTIFICATION, { id: "b" }, () => 100);
    claimOutbox.enqueue("notification:a", OUTBOX_EVENT_TYPES.NOTIFICATION, { id: "a" }, () => 100);
    const claimed = claimOutbox.claim(1, () => 100, 1_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.idempotencyKey).toBe("notification:a");

    const outbox = new SideEffectOutbox();
    outbox.enqueue("notification:complete", OUTBOX_EVENT_TYPES.NOTIFICATION, notification, () => 100);
    const result = await outbox.process(async () => undefined, { maxAttempts: 3 }, () => 100);
    expect(result).toEqual({ claimed: 1, completed: 1, retried: 0, deadLettered: 0 });
    expect(outbox.getByKey("notification:complete")?.status).toBe("completed");
  });

  it("recovers a claimed event after its worker crashes", async () => {
    const outbox = new SideEffectOutbox();
    outbox.enqueue("payout:crash", OUTBOX_EVENT_TYPES.PAYOUT, payout, () => 100);
    outbox.claim(1, () => 100, 10);
    expect(outbox.getByKey("payout:crash")?.status).toBe("processing");

    const result = await outbox.process(async () => undefined, { maxAttempts: 2 }, () => 111);
    expect(result.completed).toBe(1);
    expect(outbox.getByKey("payout:crash")?.attempts).toBe(2);
  });

  it("retries a failed handler with bounded backoff", async () => {
    const outbox = new SideEffectOutbox();
    outbox.enqueue("notification:retry", OUTBOX_EVENT_TYPES.NOTIFICATION, notification, () => 100);
    let calls = 0;
    const first = await outbox.process(async () => {
      calls += 1;
      throw new Error("temporary provider outage");
    }, { maxAttempts: 3, backoffBaseMs: 50, backoffMaxMs: 60 }, () => 100);
    expect(first).toEqual({ claimed: 1, completed: 0, retried: 1, deadLettered: 0 });
    expect(calls).toBe(1);
    expect(outbox.getByKey("notification:retry")?.status).toBe("pending");
    expect(outbox.getByKey("notification:retry")?.availableAt).toBe(150);

    const second = await outbox.process(async () => undefined, { maxAttempts: 3 }, () => 150);
    expect(second.completed).toBe(1);
    expect(outbox.getByKey("notification:retry")?.lastError).toBeNull();
  });

  it("moves a poison message to the terminal state after exhaustion", async () => {
    const outbox = new SideEffectOutbox();
    outbox.enqueue("notification:poison", OUTBOX_EVENT_TYPES.NOTIFICATION, notification, () => 100);
    const first = await outbox.process(async () => { throw new Error("invalid recipient"); }, {
      maxAttempts: 2,
      backoffBaseMs: 0,
    }, () => 100);
    expect(first.retried).toBe(1);
    const second = await outbox.process(async () => { throw new Error("invalid recipient"); }, {
      maxAttempts: 2,
      backoffBaseMs: 0,
    }, () => 100);
    expect(second.deadLettered).toBe(1);
    expect(outbox.getByKey("notification:poison")?.status).toBe("dead_letter");
    expect(outbox.getByKey("notification:poison")?.lastError).toBe("invalid recipient");
  });

  it("does not let a poison event block a healthy event", async () => {
    const outbox = new SideEffectOutbox();
    outbox.enqueue("notification:poison", OUTBOX_EVENT_TYPES.NOTIFICATION, { id: "poison" }, () => 100);
    outbox.enqueue("payout:healthy", OUTBOX_EVENT_TYPES.PAYOUT, payout, () => 100);
    const handled: string[] = [];
    const result = await outbox.process(async (event) => {
      handled.push(event.idempotencyKey);
      if (event.idempotencyKey === "notification:poison") throw new Error("poison");
    }, { maxAttempts: 1, backoffBaseMs: 0 }, () => 100);
    expect(result).toEqual({ claimed: 2, completed: 1, retried: 0, deadLettered: 1 });
    expect(handled).toEqual(["notification:poison", "payout:healthy"]);
    expect(outbox.getByKey("payout:healthy")?.status).toBe("completed");
  });

  it("rejects invalid processor settings with a stable code", async () => {
    const outbox = new SideEffectOutbox();
    await expect(outbox.process(async () => undefined, { maxAttempts: 0 })).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    } satisfies Partial<OutboxError>);
  });
});
