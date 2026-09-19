CREATE TABLE "messageHides" (
	"messageId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "messageHides_messageId_userId_pk" PRIMARY KEY("messageId","userId")
);
--> statement-breakpoint
CREATE TABLE "messageReactions" (
	"messageId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"emoji" varchar(16) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "messageReactions_messageId_userId_pk" PRIMARY KEY("messageId","userId")
);
--> statement-breakpoint
CREATE TABLE "messageStars" (
	"messageId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "messageStars_messageId_userId_pk" PRIMARY KEY("messageId","userId")
);
--> statement-breakpoint
ALTER TABLE "conversationMembers" ADD COLUMN "lastDeliveredAt" timestamp;--> statement-breakpoint
ALTER TABLE "conversationMembers" ADD COLUMN "archived" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversationMembers" ADD COLUMN "muted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversationMembers" ADD COLUMN "pinned" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversationMembers" ADD COLUMN "draft" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "description" varchar(255);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "disappearSeconds" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "replyToId" varchar(64);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "forwardedFromId" varchar(64);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "viewOnce" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "editedAt" timestamp;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deletedAt" timestamp;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "expiresAt" timestamp;