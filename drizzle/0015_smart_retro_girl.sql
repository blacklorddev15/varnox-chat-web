ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "suspendedAt" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "suspendedReason" text;
