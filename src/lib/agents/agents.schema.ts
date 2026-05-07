import { jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const agentStatusEnum = pgEnum('agent_status', ['active', 'paused', 'idle'])

/**
 * Wave 3 #14 evaluations plan phase 1 — agent role/kind taxonomy.
 *
 * `orchestrator` and `worker` cover existing agents; `evaluator` is a new specialized kind that
 * the runtime spawns post-run when `chat_runs.eval_required = true`. The kind drives default
 * tool surface (evaluators get read-only tools), default model (cheap), and structured-output
 * expectations on the LLM call.
 */
export const agentKindEnum = pgEnum('agent_kind', ['orchestrator', 'worker', 'evaluator'])

export const agents = pgTable(
	'agents',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		name: text('name').notNull(),
		role: text('role').notNull(),
		systemPrompt: text('system_prompt').notNull(),
		model: text('model').notNull().default('anthropic/claude-sonnet-4'),
		config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
		status: agentStatusEnum('status').notNull().default('idle'),
		kind: agentKindEnum('kind').notNull().default('worker'),
		parentAgentId: uuid('parent_agent_id'),
		// Wave 5 #22 phase 2 — optional link to a `skill` row whose content overrides
		// `system_prompt` at runtime. Operators edit the skill at /skills/[id] and the next
		// run picks up the change without a deploy. Declared by-name (no enforced FK) so
		// deleting a skill leaves the agent's pointer stale; buildAgentDefinition falls back
		// to `systemPrompt` when the skill is missing/disabled. Same pattern as the
		// orchestrator-identity skill from Phase 1.
		identitySkillId: uuid('identity_skill_id'),
		// Built-in agents (chat / research / plan / autonomous) carry a stable key so the
		// seeder can upsert by it and the picker can pin them ahead of user-created agents.
		// NULL for user-created agents. Partial unique index enforces uniqueness only on
		// non-null values.
		builtinKey: text('builtin_key'),
		// One-line system message persisted to conversation history when the agent changes.
		// Built-ins seed this with their persona-specific sentence; user agents leave it null
		// and the switcher falls back to a generic `[Agent changed to ${name}] ...` line.
		anchorPrompt: text('anchor_prompt'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		builtinKeyUidx: uniqueIndex('agents_builtin_key_uidx')
			.on(table.builtinKey)
			.where(sql`${table.builtinKey} IS NOT NULL`),
	}),
)
