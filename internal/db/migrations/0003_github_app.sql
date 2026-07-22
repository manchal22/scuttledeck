CREATE TABLE "github_app" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" bigint NOT NULL,
	"slug" text,
	"owner" text,
	"pem" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"client_id" text,
	"html_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_state" (
	"state" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
