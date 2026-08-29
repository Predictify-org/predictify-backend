CREATE TABLE "referral_reward_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount" text NOT NULL,
	"asset" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_reward_allocations_referral_id_unique" UNIQUE("referral_id"),
	CONSTRAINT "referral_reward_allocations_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "referral_reward_allocations" ADD CONSTRAINT "referral_reward_allocations_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "referral_reward_allocations_referral_id_idx" ON "referral_reward_allocations" USING btree ("referral_id");