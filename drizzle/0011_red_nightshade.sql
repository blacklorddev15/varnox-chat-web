CREATE TABLE "conversationIcons" (
	"conversationId" varchar(64) PRIMARY KEY NOT NULL,
	"mimeType" text NOT NULL,
	"data" text NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groupEvents" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversationId" varchar(64) NOT NULL,
	"actorId" integer,
	"kind" varchar(32) NOT NULL,
	"targetUserId" integer,
	"detail" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversationMembers" ADD COLUMN "lockedAt" timestamp;--> statement-breakpoint
ALTER TABLE "statusUpdates" ADD COLUMN "mediaMime" varchar(100);--> statement-breakpoint
ALTER TABLE "statusUpdates" ADD COLUMN "voiceDurationMs" integer;--> statement-breakpoint
ALTER TABLE "userSettings" ADD COLUMN "profilePhotoVisibility" varchar(16) DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "userSettings" ADD COLUMN "aboutVisibility" varchar(16) DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "userSettings" ADD COLUMN "statusVisibility" varchar(16) DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "userSettings" ADD COLUMN "groupAddPolicy" varchar(16) DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "userSettings" ADD COLUMN "silenceUnknownCallers" integer DEFAULT 0 NOT NULL;