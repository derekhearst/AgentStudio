-- Deep Research rebuild — refresh mode-identity skills.
--
-- Deletes the four mode-identity skill rows so the bootstrap seeder (`seedModeIdentitySkills`
-- in src/lib/chat/mode-skills.server.ts) re-inserts them with the new prompt content on next
-- boot. Skip the UUID-bump pattern (used for plan c003 → c023): the seeder uses no-target
-- ON CONFLICT DO NOTHING which would swallow name-uniqueness collisions on existing DBs and
-- leave the new rows uninserted. Direct delete + reseed is cleaner and keeps the UUIDs
-- stable for downstream code that imports MODE_SKILL_IDS.

DELETE FROM "skills" WHERE "id" IN (
  '00000000-0000-4000-8000-00000000c001',
  '00000000-0000-4000-8000-00000000c002',
  '00000000-0000-4000-8000-00000000c023',
  '00000000-0000-4000-8000-00000000c004'
);
