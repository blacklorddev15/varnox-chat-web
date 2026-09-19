ALTER TYPE "public"."message_kind" ADD VALUE 'poll';--> statement-breakpoint
ALTER TYPE "public"."message_kind" ADD VALUE 'location';--> statement-breakpoint
ALTER TYPE "public"."message_kind" ADD VALUE 'contact';--> statement-breakpoint
CREATE TABLE "pollVotes" (
	"messageId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"optionIndex" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pollVotes_messageId_userId_pk" PRIMARY KEY("messageId","userId")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "meta" jsonb;