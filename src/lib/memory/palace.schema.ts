import { boolean, pgEnum, pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'

export const hallTypeEnum = pgEnum('hall_type', ['facts', 'events', 'discoveries', 'preferences', 'advice'])

export const memoryWings = pgTable('memory_wings', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	description: text('description'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const memoryRooms = pgTable('memory_rooms', {
	id: uuid('id').primaryKey().defaultRandom(),
	wingId: uuid('wing_id')
		.notNull()
		.references(() => memoryWings.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	description: text('description'),
	isCloset: boolean('is_closet').notNull().default(false),
	closetForRoomId: uuid('closet_for_room_id').references((): AnyPgColumn => memoryRooms.id, {
		onDelete: 'set null',
	}),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
