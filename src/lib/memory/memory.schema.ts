import { sql } from 'drizzle-orm'
import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	real,
	text,
	timestamp,
	unique,
	uuid,
	vector,
} from 'drizzle-orm/pg-core'

import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'
import { conversations, messages } from '$lib/chat/chat.schema'

/**
 * MemPalace memory schema (ported to TypeScript/Drizzle/pgvector).
 *
 * Hierarchy: Wing (entity) -> Room (time slice) -> Closet (topic) -> Drawer (verbatim chunk).
 * Each drawer carries a 1536-dim embedding (text-embedding-3-small) and an AAAK index.
 * The temporal knowledge graph (entities + relations with valid windows) lives alongside.
 */

export const memoryWingKindEnum = pgEnum('memory_wing_kind', ['person', 'project', 'topic', 'agent'])
export const memoryDrawerRoleEnum = pgEnum('memory_drawer_role', ['user', 'assistant', 'system', 'note'])

export const memoryWings = pgTable(
	'memory_wings',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
		kind: memoryWingKindEnum('kind').notNull().default('topic'),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		aliases: text('aliases').array().notNull().default(sql`ARRAY[]::text[]`),
		summary: text('summary'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique('memory_wings_user_slug_unique').on(t.userId, t.slug),
		index('memory_wings_user_idx').on(t.userId),
		index('memory_wings_aliases_gin').using('gin', t.aliases),
	],
)

export const memoryRooms = pgTable(
	'memory_rooms',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wingId: uuid('wing_id')
			.notNull()
			.references(() => memoryWings.id, { onDelete: 'cascade' }),
		conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
		label: text('label').notNull(),
		summary: text('summary'),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index('memory_rooms_wing_idx').on(t.wingId),
		index('memory_rooms_occurred_idx').on(t.wingId, t.occurredAt),
	],
)

export const memoryClosets = pgTable(
	'memory_closets',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		roomId: uuid('room_id')
			.notNull()
			.references(() => memoryRooms.id, { onDelete: 'cascade' }),
		topic: text('topic').notNull(),
		summary: text('summary'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index('memory_closets_room_idx').on(t.roomId),
		unique('memory_closets_room_topic_unique').on(t.roomId, t.topic),
	],
)

export const memoryDrawers = pgTable(
	'memory_drawers',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		closetId: uuid('closet_id')
			.notNull()
			.references(() => memoryClosets.id, { onDelete: 'cascade' }),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		role: memoryDrawerRoleEnum('role').notNull().default('note'),
		content: text('content').notNull(),
		embedding: vector('embedding', { dimensions: 1536 }),
		aaak: jsonb('aaak').$type<{
			pointer: string
			tags: { p?: string[]; l?: string[]; e?: string[]; i?: string[]; t?: string[] }
		}>(),
		tokenCount: integer('token_count').notNull().default(0),
		sourceMessageId: uuid('source_message_id').references(() => messages.id, { onDelete: 'set null' }),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index('memory_drawers_closet_idx').on(t.closetId),
		index('memory_drawers_user_occurred_idx').on(t.userId, t.occurredAt),
		// HNSW index for cosine semantic search; added by hand-edited migration.
		index('memory_drawers_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
		index('memory_drawers_content_tsv_idx').using(
			'gin',
			sql`to_tsvector('english', ${t.content})`,
		),
	],
)

export const memoryKgEntities = pgTable(
	'memory_kg_entities',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		type: text('type').notNull().default('thing'),
		attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index('memory_kg_entities_user_idx').on(t.userId),
		unique('memory_kg_entities_user_name_type_unique').on(t.userId, t.name, t.type),
	],
)

export const memoryKgRelations = pgTable(
	'memory_kg_relations',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		fromEntityId: uuid('from_entity_id')
			.notNull()
			.references(() => memoryKgEntities.id, { onDelete: 'cascade' }),
		toEntityId: uuid('to_entity_id')
			.notNull()
			.references(() => memoryKgEntities.id, { onDelete: 'cascade' }),
		relation: text('relation').notNull(),
		validFrom: timestamp('valid_from', { withTimezone: true }).defaultNow().notNull(),
		validTo: timestamp('valid_to', { withTimezone: true }),
		confidence: real('confidence').notNull().default(1),
		sourceDrawerId: uuid('source_drawer_id').references(() => memoryDrawers.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index('memory_kg_relations_user_idx').on(t.userId),
		index('memory_kg_relations_from_idx').on(t.fromEntityId, t.validFrom),
		index('memory_kg_relations_to_idx').on(t.toEntityId, t.validFrom),
	],
)

export type MemoryWing = typeof memoryWings.$inferSelect
export type MemoryRoom = typeof memoryRooms.$inferSelect
export type MemoryCloset = typeof memoryClosets.$inferSelect
export type MemoryDrawer = typeof memoryDrawers.$inferSelect
export type MemoryKgEntity = typeof memoryKgEntities.$inferSelect
export type MemoryKgRelation = typeof memoryKgRelations.$inferSelect
