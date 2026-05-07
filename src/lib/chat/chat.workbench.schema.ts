import { boolean, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'

export type WorkbenchPanelLayout = {
	openTab?: string
	width?: number
	[key: string]: unknown
}

export const chatWorkbenchPreferences = pgTable('chat_workbench_preferences', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' })
		.unique(),
	// Default agent for new conversations. Nullable so a deleted custom-agent default
	// gracefully falls back to the built-in Chat agent (resolveDefaultAgentId in
	// agent-switch.server.ts).
	defaultAgentId: uuid('default_agent_id').references(() => agents.id, { onDelete: 'set null' }),
	showRightPanel: boolean('show_right_panel').notNull().default(true),
	panelLayout: jsonb('panel_layout').$type<WorkbenchPanelLayout>(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
