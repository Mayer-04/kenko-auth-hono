CREATE TABLE "refresh_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_sessions_token_hash_unique" ON "refresh_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_sessions_family_idx" ON "refresh_sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_sessions_user_idx" ON "refresh_sessions" USING btree ("user_id");