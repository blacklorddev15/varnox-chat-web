CREATE TABLE "joinRequests" (
	"conversationId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"requestedAt" timestamp DEFAULT now() NOT NULL,
	"decidedAt" timestamp,
	"decidedBy" integer,
	CONSTRAINT "joinRequests_conversationId_userId_pk" PRIMARY KEY("conversationId","userId")
);
--> statement-breakpoint
ALTER TABLE "conversationMembers" ADD COLUMN "mediaAutoLoad" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "approveNewMembers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "userSettings" ADD COLUMN "autoDownloadMedia" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "userSettings" ADD COLUMN "defaultDisappearSeconds" integer DEFAULT 0 NOT NULL;