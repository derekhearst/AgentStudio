import { boolean, integer, pgEnum, pgTable, real, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core'
import { hallTypeEnum, memoryRooms, memoryWings } from '$lib/memory/palace.schema'

export const memoryRelationTypeEnum = pgEnum('memory_relation_type', [
	'supports',
	'contradicts',
	'depends_on',
	'part_of',
])

export const memories = pgTable('memories', {
	id: uuid('id').primaryKey().defaultRandom(),
	content: text('content').notNull(),
	category: text('category').notNull().default('general'),
	importance: real('importance').notNull().default(0.5),
	wingId: uuid('wing_id').references(() => memoryWings.id, { onDelete: 'set null' }),
	roomId: uuid('room_id').references(() => memoryRooms.id, { onDelete: 'set null' }),
	hallType: hallTypeEnum('hall_type').notNull().default('discoveries'),
	isCloset: boolean('is_closet').notNull().default(false),
	closetForRoomId: uuid('closet_for_room_id').references(() => memoryRooms.id, { onDelete: 'set null' }),
	embedding: vector('embedding', { dimensions: 1536 }),
	accessCount: integer('access_count').notNull().default(0),
	lastAccessed: timestamp('last_accessed', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	decayedAt: timestamp('decayed_at', { withTimezone: true }),
})

export const memoryRelations = pgTable('memory_relations', {
	id: uuid('id').primaryKey().defaultRandom(),
	sourceMemoryId: uuid('source_memory_id')
		.notNull()
		.references(() => memories.id, { onDelete: 'cascade' }),
	targetMemoryId: uuid('target_memory_id')
		.notNull()
		.references(() => memories.id, { onDelete: 'cascade' }),
	relationType: memoryRelationTypeEnum('relation_type').notNull(),
	strength: real('strength').notNull().default(0.5),
})
