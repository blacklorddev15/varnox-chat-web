ALTER TYPE "public"."message_kind" ADD VALUE 'sticker';--> statement-breakpoint
CREATE TABLE "broadcastLists" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"name" varchar(64) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcastRecipients" (
	"listId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	CONSTRAINT "broadcastRecipients_listId_userId_pk" PRIMARY KEY("listId","userId")
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" varchar(255),
	"createdBy" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communityGroups" (
	"communityId" varchar(64) NOT NULL,
	"conversationId" varchar(64) NOT NULL,
	CONSTRAINT "communityGroups_communityId_conversationId_pk" PRIMARY KEY("communityId","conversationId")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"userAgent" varchar(255),
	"platform" varchar(32),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"lastSeenAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stickers" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"mimeType" text NOT NULL,
	"data" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "userSettings" ADD COLUMN "pinHash" text;