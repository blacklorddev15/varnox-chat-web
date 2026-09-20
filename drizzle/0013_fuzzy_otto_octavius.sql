CREATE TABLE "catalogItems" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"ownerId" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"priceCents" integer,
	"currency" varchar(8) DEFAULT 'USD' NOT NULL,
	"imageUrl" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"archivedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"ownerId" integer NOT NULL,
	"targetId" integer NOT NULL,
	"displayName" varchar(80) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_ownerId_targetId_pk" PRIMARY KEY("ownerId","targetId")
);
--> statement-breakpoint
CREATE TABLE "deviceLinkCodes" (
	"code" varchar(16) PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"usedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "eventRsvps" (
	"eventId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"response" varchar(16) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "eventRsvps_eventId_userId_pk" PRIMARY KEY("eventId","userId")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"conversationId" varchar(64) NOT NULL,
	"creatorId" integer NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text,
	"startsAt" timestamp NOT NULL,
	"endsAt" timestamp,
	"location" varchar(200),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"cancelledAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "liveLocations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"conversationId" varchar(64) NOT NULL,
	"userId" integer NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"label" varchar(120),
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"stoppedAt" timestamp
);
