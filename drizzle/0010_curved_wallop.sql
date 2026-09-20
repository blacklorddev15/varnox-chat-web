CREATE TABLE "linkPreviews" (
	"url" varchar(1024) PRIMARY KEY NOT NULL,
	"title" varchar(300),
	"description" text,
	"siteName" varchar(120),
	"imageUrl" varchar(1024),
	"fetchedAt" timestamp,
	"failedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "messageKeeps" (
	"messageId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "messageKeeps_messageId_userId_pk" PRIMARY KEY("messageId","userId")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"reporterId" integer NOT NULL,
	"targetUserId" integer,
	"conversationId" varchar(64),
	"messageId" varchar(64),
	"category" varchar(32) NOT NULL,
	"note" text,
	"excerpt" text,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"reviewedBy" integer,
	"reviewNote" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "pinnedAt" timestamp;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "pinnedBy" integer;