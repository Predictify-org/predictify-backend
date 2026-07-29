CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"referral_code" text NOT NULL,
	"campaign_id" text,
	"referred_user" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referral_code_unique" UNIQUE("referral_code");
--> statement-breakpoint
CREATE INDEX "referrals_user_id_idx" ON "referrals" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "referrals_code_idx" ON "referrals" USING btree ("referral_code");
