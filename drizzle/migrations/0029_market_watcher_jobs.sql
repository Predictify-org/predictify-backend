CREATE TABLE "market_watcher_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" text NOT NULL,
	"job_key" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"watchers_notified" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_watcher_jobs_job_key_unique" UNIQUE("job_key")
);
--> statement-breakpoint
ALTER TABLE "market_watcher_jobs" ADD CONSTRAINT "market_watcher_jobs_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "market_watcher_jobs_market_event_idx" ON "market_watcher_jobs" USING btree ("market_id", "event_type");
--> statement-breakpoint
CREATE INDEX "market_watcher_jobs_ready_idx" ON "market_watcher_jobs" USING btree ("status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX "market_watcher_jobs_lease_idx" ON "market_watcher_jobs" USING btree ("status", "lease_until");
