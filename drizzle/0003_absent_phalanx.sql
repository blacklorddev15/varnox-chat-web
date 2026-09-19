CREATE TABLE "presence" (
	"userId" integer PRIMARY KEY NOT NULL,
	"lastSeenAt" timestamp DEFAULT now() NOT NULL,
	"typingConversationId" varchar(64),
	"typingUntil" timestamp
);
