CREATE TABLE "scheduled_report_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheduled_report_id" uuid NOT NULL,
	"schedule_key" text NOT NULL,
	"run_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"output_ref" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_report_runs_identity_unique" UNIQUE("scheduled_report_id", "run_for")
);
--> statement-breakpoint
ALTER TABLE "scheduled_report_runs" ADD CONSTRAINT "scheduled_report_runs_scheduled_report_id_fk" FOREIGN KEY ("scheduled_report_id") REFERENCES "public"."scheduled_reports"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "scheduled_report_runs_identity_idx" ON "scheduled_report_runs" USING btree ("scheduled_report_id", "run_for");
--> statement-breakpoint
CREATE INDEX "scheduled_report_runs_ready_idx" ON "scheduled_report_runs" USING btree ("status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX "scheduled_report_runs_lease_idx" ON "scheduled_report_runs" USING btree ("status", "lease_until");
