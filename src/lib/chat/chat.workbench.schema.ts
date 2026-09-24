import { boolean, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'

export type WorkbenchPanelLayout = {
	openTab?: string
	width?: number
	/**
	 * #14 — the chat's right rail is expanded (true) or folded to its thin strip (false or
	 * absent, the default). Read and written by `$lib/chat-console/rail-open.server`.
	 */
	railOpen?: boolean
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
	// Unused: nothing reads or sets it from the UI. The rail's expanded/collapsed state is
	// `panelLayout.railOpen` instead, because the rail is collapsed by default and this
	// column defaults to true — flipping that default would take a migration.
	showRightPanel: boolean('show_right_panel').notNull().default(true),
	panelLayout: jsonb('panel_layout').$type<WorkbenchPanelLayout>(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
