import { boolean, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'

/**
 * Per-(user, agent?, slotName) overrides for the slot-based system-prompt assembly.
 *
 * - `agentId IS NULL` → override applies to all chats this user starts that don't have a more
 *   specific per-agent override.
 * - `agentId IS NOT NULL` → override applies only to runs of that specific agent (orchestrator
 *   chats use null since there's no agent).
 *
 * Any field set to NULL means "use the bundled default" for that aspect.
 *
 * Spec: docs/context/spec.md → `contextSlotConfigs`.
 */
export const contextSlotConfigs = pgTable(
	'context_slot_configs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
		slotName: text('slot_name').notNull(),
		tokenBudget: integer('token_budget'),
		priority: integer('priority'),
		enabled: boolean('enabled').notNull().default(true),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		// One row per (user, agent-or-null, slot). agentId NULL is treated as a distinct value
		// by Postgres unique constraints, so user-wide overrides coexist with per-agent overrides.
		userAgentSlotIdx: unique('context_slot_configs_user_agent_slot_unique').on(
			t.userId,
			t.agentId,
			t.slotName,
		),
		userIdx: index('context_slot_configs_user_idx').on(t.userId),
		agentIdx: index('context_slot_configs_agent_idx').on(t.agentId),
	}),
)
