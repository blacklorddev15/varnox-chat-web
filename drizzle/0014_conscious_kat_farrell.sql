CREATE TABLE "webPushSubscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "webPushSubscriptions_endpoint_unique" UNIQUE("endpoint")
);
