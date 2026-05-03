ALTER TABLE "skills" ADD COLUMN "description_embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "description_embedded_at" timestamp with time zone;