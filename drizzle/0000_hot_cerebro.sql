CREATE TYPE "public"."audit_outcome" AS ENUM('SUCCESS', 'FAILURE');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('STAGED', 'READY', 'MISSING');--> statement-breakpoint
CREATE TYPE "public"."import_batch_status" AS ENUM('PENDING', 'PARSED', 'VALIDATED', 'COMMITTED', 'ROLLED_BACK', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('PENDING', 'SUCCESS', 'WARNING', 'ERROR', 'EXCLUDED');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blob_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_sort_order_nonnegative" CHECK ("attachments"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"outcome" "audit_outcome" NOT NULL,
	"request_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_action_length" CHECK (char_length("audit_logs"."action") BETWEEN 3 AND 100),
	CONSTRAINT "audit_logs_request_id_length" CHECK (char_length("audit_logs"."request_id") BETWEEN 8 AND 100)
);
--> statement-breakpoint
CREATE TABLE "auth_login_attempts" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"blocked_until" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_attempt_key_hash_sha256" CHECK (char_length("auth_login_attempts"."key_hash") = 64),
	CONSTRAINT "auth_attempt_failed_nonnegative" CHECK ("auth_login_attempts"."failed_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "file_blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checksum_sha256" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"storage_path" text,
	"status" "file_status" DEFAULT 'STAGED' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_blobs_checksum_sha256" CHECK (char_length("file_blobs"."checksum_sha256") = 64),
	CONSTRAINT "file_blobs_size_nonnegative" CHECK ("file_blobs"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_name" text NOT NULL,
	"source_checksum" text NOT NULL,
	"source_byte_size" bigint NOT NULL,
	"status" "import_batch_status" DEFAULT 'PENDING' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"success_rows" integer DEFAULT 0 NOT NULL,
	"warning_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_checksum_sha256" CHECK (char_length("import_batches"."source_checksum") = 64),
	CONSTRAINT "import_batches_size_nonnegative" CHECK ("import_batches"."source_byte_size" >= 0),
	CONSTRAINT "import_batches_counts_nonnegative" CHECK (
    "import_batches"."total_rows" >= 0 AND "import_batches"."success_rows" >= 0 AND "import_batches"."warning_rows" >= 0 AND "import_batches"."error_rows" >= 0
  ),
	CONSTRAINT "import_batches_counts_within_total" CHECK (
    "import_batches"."success_rows" + "import_batches"."warning_rows" + "import_batches"."error_rows" <= "import_batches"."total_rows"
  )
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"sheet_name" text NOT NULL,
	"source_row" integer NOT NULL,
	"status" "import_row_status" DEFAULT 'PENDING' NOT NULL,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"normalized_payload" jsonb,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_source_row_positive" CHECK ("import_rows"."source_row" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_sha256" CHECK (char_length("sessions"."token_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_normalized" CHECK ("users"."username" = lower("users"."username")),
	CONSTRAINT "users_username_length" CHECK (char_length("users"."username") BETWEEN 3 AND 64)
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_blob_id_file_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."file_blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_blobs" ADD CONSTRAINT "file_blobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_entity_blob_key" ON "attachments" USING btree ("entity_type","entity_id","blob_id");--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("entity_type","entity_id","sort_order");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_blobs_checksum_key" ON "file_blobs" USING btree ("checksum_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_source_checksum_key" ON "import_batches" USING btree ("source_checksum");--> statement-breakpoint
CREATE INDEX "import_batches_status_created_idx" ON "import_batches" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_batch_sheet_row_key" ON "import_rows" USING btree ("batch_id","sheet_name","source_row");--> statement-breakpoint
CREATE INDEX "import_rows_batch_status_idx" ON "import_rows" USING btree ("batch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_active_idx" ON "sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree ("username");