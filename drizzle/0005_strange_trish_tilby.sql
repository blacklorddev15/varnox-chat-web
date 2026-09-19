-- The inviteLinks table is deliberately not created here: it already exists in the database from an
-- earlier build, with exactly these columns, so CREATE TABLE would abort the whole migration.
-- Generating this file re-added it because the table had been dropped from schema.ts while the table
-- itself survived. Declaring it in the schema again keeps drizzle's snapshot honest, which leaves
-- this migration carrying only the genuinely new columns below.

ALTER TABLE "conversations" ADD COLUMN "whoCanSend" varchar(16) DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "whoCanEditInfo" varchar(16) DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "whoCanAddMembers" varchar(16) DEFAULT 'all' NOT NULL;