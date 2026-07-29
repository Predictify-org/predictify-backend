CREATE TABLE "market_watchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_watchers" ADD CONSTRAINT "market_watchers_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "market_watchers" ADD CONSTRAINT "market_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "market_watchers_market_id_idx" ON "market_watchers" USING btree ("market_id");
--> statement-breakpoint
CREATE INDEX "market_watchers_user_id_idx" ON "market_watchers" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "market_watchers_market_user_idx" ON "market_watchers" USING btree ("market_id","user_id");
