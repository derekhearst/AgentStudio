-- messages.sequence — explicit per-conversation ordering counter.
--
-- Replaces the implicit "order by created_at, id" workaround. The handler that streams
-- a chat turn writes user + assistant rows back-to-back, both with `created_at = now()`.
-- On fast turns those timestamps collide at the millisecond, so the rendered order was
-- determined by client-side tiebreakers (role-priority + uuid lex order). That worked,
-- but it was fragile (any read site without the same tiebreaker produced a different
-- order) and impossible to extend to per-row metadata that depends on position.
--
-- The new column is assigned via insertMessageWithSequence() inside the same transaction
-- as the row insert. The (conversation_id, sequence) unique index serializes racing
-- writers — the loser hits SQLSTATE 23505 and the helper retries with the new max+1.
--
-- Backfill order (created_at ASC, id ASC) matches the existing client-side tiebreaker
-- exactly, so existing conversations don't reshuffle when the migration runs.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sequence" integer;
--> statement-breakpoint
UPDATE "messages" m
SET "sequence" = sub.seq
FROM (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY conversation_id
    ORDER BY created_at ASC, id ASC
  ) AS seq
  FROM "messages"
) sub
WHERE m.id = sub.id;
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "sequence" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_conv_seq_uniq" ON "messages" ("conversation_id", "sequence");
