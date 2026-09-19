-- Status updates and channels.
--
-- This migration intentionally contains only the five new tables. drizzle-kit also
-- generated catch-up statements for calls, messageMedia, userAvatars and a few columns
-- that were added to schema.ts after 0000 but never captured in a migration; those
-- objects already exist in the deployed database, so re-creating them would abort the
-- whole migration with "already exists". The snapshot in meta/ still records them, so
-- future diffs stay correct. See the accompanying notes for the catch-up SQL to run on
-- a brand new database.

CREATE TABLE IF NOT EXISTS "channelFollowers" (
	"channelId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"followedAt" timestamp DEFAULT now() NOT NULL,
	"lastReadAt" timestamp,
	CONSTRAINT "channelFollowers_channelId_userId_pk" PRIMARY KEY("channelId","userId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channelPosts" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"channelId" varchar(64) NOT NULL,
	"authorId" integer NOT NULL,
	"body" text NOT NULL,
	"mediaUrl" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"removedAt" timestamp,
	"removedBy" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channels" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"ownerId" integer NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"suspendedAt" timestamp,
	"suspendedReason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "statusUpdates" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"kind" varchar(8) DEFAULT 'text' NOT NULL,
	"body" text,
	"mediaUrl" text,
	"background" varchar(16) DEFAULT 'amber' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"removedAt" timestamp,
	"removedBy" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "statusViews" (
	"statusId" varchar(64) NOT NULL,
	"viewerId" integer NOT NULL,
	"viewedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "statusViews_statusId_viewerId_pk" PRIMARY KEY("statusId","viewerId")
);
