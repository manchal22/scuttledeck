CREATE TABLE "agent_session" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer,
	"session_id" text NOT NULL,
	"repo_full_name" text,
	"gh_run_id_hint" bigint,
	"model" text,
	"tok_in" bigint DEFAULT 0 NOT NULL,
	"tok_out" bigint DEFAULT 0 NOT NULL,
	"tok_cache_read" bigint DEFAULT 0 NOT NULL,
	"tok_cache_create" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"source" text NOT NULL,
	"confidence" text DEFAULT 'unmatched' NOT NULL,
	"resource_attrs" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "alert_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "alert_rule" (
	"id" serial PRIMARY KEY NOT NULL,
	"installation_id" integer,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"installation_id" integer,
	"day" timestamp with time zone NOT NULL,
	"api_key_name" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"tok_in" bigint DEFAULT 0 NOT NULL,
	"tok_out" bigint DEFAULT 0 NOT NULL,
	"tok_cache_read" bigint DEFAULT 0 NOT NULL,
	"tok_cache_create" bigint DEFAULT 0 NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"est_cost_usd" numeric(12, 6),
	"billed_cost_usd" numeric(12, 6)
);
--> statement-breakpoint
CREATE TABLE "installation" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_install_id" bigint,
	"org" text NOT NULL,
	"admin_api_key_ref" text,
	"ingest_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_github_install_id_unique" UNIQUE("github_install_id"),
	CONSTRAINT "installation_org_unique" UNIQUE("org")
);
--> statement-breakpoint
CREATE TABLE "pr_interaction" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"pr_number" integer NOT NULL,
	"kind" text NOT NULL,
	"author" text,
	"run_id" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo" (
	"id" serial PRIMARY KEY NOT NULL,
	"installation_id" integer,
	"gh_repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text,
	"has_action" boolean DEFAULT false NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_gh_repo_id_unique" UNIQUE("gh_repo_id"),
	CONSTRAINT "repo_full_name_unique" UNIQUE("full_name")
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"gh_run_id" bigint NOT NULL,
	"gh_run_attempt" integer DEFAULT 1 NOT NULL,
	"workflow_id" integer,
	"workflow_path" text,
	"workflow_name" text,
	"trigger_event" text,
	"actor" text,
	"pr_number" integer,
	"head_branch" text,
	"head_sha" text,
	"status" text NOT NULL,
	"conclusion" text,
	"html_url" text,
	"run_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_s" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_gh_run_id_unique" UNIQUE("gh_run_id")
);
--> statement-breakpoint
CREATE TABLE "session_metric" (
	"session_id" text NOT NULL,
	"metric" text NOT NULL,
	"attr_type" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"value" numeric(20, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_metric_session_id_metric_attr_type_model_pk" PRIMARY KEY("session_id","metric","attr_type","model")
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_delivery_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
CREATE TABLE "workflow" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"path" text NOT NULL,
	"name" text,
	"action_ref" text,
	"action_version" text,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_config" jsonb,
	"last_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_rule_id_alert_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_daily" ADD CONSTRAINT "cost_daily_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_interaction" ADD CONSTRAINT "pr_interaction_repo_id_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_interaction" ADD CONSTRAINT "pr_interaction_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo" ADD CONSTRAINT "repo_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_repo_id_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_repo_id_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_run_idx" ON "agent_session" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_session_hint_idx" ON "agent_session" USING btree ("gh_run_id_hint");--> statement-breakpoint
CREATE INDEX "agent_session_repo_idx" ON "agent_session" USING btree ("repo_full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_daily_uq" ON "cost_daily" USING btree ("day","api_key_name","model");--> statement-breakpoint
CREATE INDEX "pr_interaction_repo_pr_idx" ON "pr_interaction" USING btree ("repo_id","pr_number");--> statement-breakpoint
CREATE INDEX "repo_installation_idx" ON "repo" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "run_repo_idx" ON "run" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "run_started_idx" ON "run" USING btree ("run_started_at");--> statement-breakpoint
CREATE INDEX "webhook_delivery_event_idx" ON "webhook_delivery" USING btree ("event");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_repo_path_uq" ON "workflow" USING btree ("repo_id","path");