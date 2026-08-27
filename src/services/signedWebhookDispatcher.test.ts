import { describe, expect, it } from "@jest/globals";
import { InMemoryWebhookStore } from "./webhookStore";
import { WebhookDispatcher } from "./webhookDispatcher";
import { SignedWebhookSecurity } from "./signedWebhookSecurity";

function security() {
  return new SignedWebhookSecurity({
    keys: [{
      id: "primary",
      secret: Buffer.from("predictify-test-secret-0123456789"),
      activeFrom: 0,
    }],
  });
}

describe("WebhookDispatcher rotating signature integration", () => {
  it("persists timestamp and nonce headers with the signed delivery", async () => {
    const store = new InMemoryWebhookStore();
    const signer = security();
    const dispatcher = new WebhookDispatcher({
      store,
      signingSecret: "legacy-secret",
      security: signer,
    });
    const payload = Buffer.from('{"event":"market.resolved"}');
    const delivery = await dispatcher.enqueue({
      eventId: "event-1",
      eventType: "market.resolved",
      targetUrl: "https://subscriber.example.test/events",
      payload,
    });
    expect(delivery.signature).toMatch(/^v1=primary,t=/);
    expect(delivery.headers).toEqual(expect.objectContaining({
      "x-predictify-timestamp": expect.any(String),
      "x-predictify-nonce": expect.any(String),
    }));
    expect(signer.verify(payload, delivery.signature).ok).toBe(true);
  });

  it("retains legacy signing when no rotating signer is configured", async () => {
    const store = new InMemoryWebhookStore();
    const dispatcher = new WebhookDispatcher({ store, signingSecret: "legacy-secret" });
    const delivery = await dispatcher.enqueue({
      eventId: "event-legacy",
      eventType: "market.created",
      targetUrl: "https://subscriber.example.test/events",
      payload: Buffer.from("legacy"),
    });
    expect(delivery.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(delivery.headers).toBeNull();
  });

  it("exposes a safe negative result when verification is not configured", () => {
    const dispatcher = new WebhookDispatcher({
      store: new InMemoryWebhookStore(),
      signingSecret: "legacy-secret",
    });
    expect(dispatcher.verifySigned(Buffer.from("payload"), "bad-header")).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });

  it("uses the stored signed header unchanged for retries", async () => {
    const store = new InMemoryWebhookStore();
    const signer = security();
    const sent: Array<Record<string, string>> = [];
    const dispatcher = new WebhookDispatcher({
      store,
      signingSecret: "legacy-secret",
      security: signer,
      send: async ({ headers }) => {
        sent.push(headers);
        return { status: 500 };
      },
      backoffMs: () => 0,
    });
    const delivery = await dispatcher.enqueue({
      eventId: "event-retry",
      eventType: "market.resolved",
      targetUrl: "https://subscriber.example.test/events",
      payload: Buffer.from("retry"),
      maxAttempts: 2,
    });
    expect(await dispatcher.attemptDelivery(delivery.id)).toBe("retry");
    expect(await dispatcher.attemptDelivery(delivery.id)).toBe("dead-lettered");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.["x-predictify-signature"]).toBe(sent[1]?.["x-predictify-signature"]);
    expect(sent[0]?.["x-predictify-timestamp"]).toBe(sent[1]?.["x-predictify-timestamp"]);
  });
});
