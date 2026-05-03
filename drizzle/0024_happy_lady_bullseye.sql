ALTER TABLE "skills" ADD COLUMN "companion_groups" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "companion_tools" text[] DEFAULT '{}' NOT NULL;