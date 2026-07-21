CREATE TABLE "pull_request" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL REFERENCES "repo"("id"),
	"pr_number" integer NOT NULL,
	"author" text,
	"title" text,
	"state" text DEFAULT 'open' NOT NULL,
	"merged" boolean DEFAULT false NOT NULL,
	"head_branch" text,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_repo_number_uq" ON "pull_request" ("repo_id","pr_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "pr_interaction_run_kind_uq" ON "pr_interaction" ("run_id","kind") WHERE "run_id" IS NOT NULL;
