import { boolean, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { chatModeEnum } from '$lib/sessions/sessions.schema'

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
	defaultMode: chatModeEnum('default_mode').notNull().default('chat'),
	showRightPanel: boolean('show_right_panel').notNull().default(true),
	panelLayout: jsonb('panel_layout').$type<WorkbenchPanelLayout>(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
