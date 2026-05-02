ALTER TABLE "chat_runs" ADD COLUMN "stream_blocks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD COLUMN "current_round" integer DEFAULT 0 NOT NULL;