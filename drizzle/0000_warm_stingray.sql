CREATE TYPE "public"."conversation_kind" AS ENUM('direct', 'group');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'image', 'video', 'file', 'voice');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "appeals" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reviewedBy" integer,
	"reviewNote" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authTokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"kind" varchar(32) NOT NULL,
	"tokenHash" varchar(128) NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"usedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "authTokens_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "blockedContacts" (
	"userId" integer NOT NULL,
	"blockedUserId" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "blockedContacts_userId_blockedUserId_pk" PRIMARY KEY("userId","blockedUserId")
);
--> statement-breakpoint
CREATE TABLE "conversationMembers" (
	"conversationId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"joinedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "conversationMembers_conversationId_userId_pk" PRIMARY KEY("conversationId","userId")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"title" varchar(255),
	"kind" "conversation_kind" DEFAULT 'direct' NOT NULL,
	"createdBy" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"conversationId" varchar(64) NOT NULL,
	"senderId" integer NOT NULL,
	"body" text,
	"kind" "message_kind" DEFAULT 'text' NOT NULL,
	"mediaUrl" text,
	"mediaMime" varchar(160),
	"mediaName" varchar(255),
	"voiceDurationMs" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pushTokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"token" varchar(512) NOT NULL,
	"platform" varchar(32),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pushTokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "userSettings" (
	"userId" integer PRIMARY KEY NOT NULL,
	"readReceipts" integer DEFAULT 1 NOT NULL,
	"lastSeen" integer DEFAULT 1 NOT NULL,
	"darkTheme" integer DEFAULT 0 NOT NULL,
	"notificationsMessages" integer DEFAULT 1 NOT NULL,
	"notificationsGroups" integer DEFAULT 1 NOT NULL,
	"notificationsCalls" integer DEFAULT 1 NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"emailVerifiedAt" timestamp,
	"username" varchar(32),
	"passwordHash" text,
	"loginMethod" varchar(64),
	"role" "role" DEFAULT 'user' NOT NULL,
	"moderationStatus" varchar(16) DEFAULT 'active' NOT NULL,
	"suspendedUntil" timestamp,
	"moderationReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
