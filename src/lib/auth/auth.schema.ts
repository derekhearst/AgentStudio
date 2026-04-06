import { boolean, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const userRoleEnum = pgEnum('user_role', ['admin', 'user'])

export const authChallengePurposeEnum = pgEnum('auth_challenge_purpose', ['register', 'authenticate'])

export const users = pgTable('users', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	username: text('username').notNull().unique(),
	role: userRoleEnum('role').notNull().default('user'),
	isActive: boolean('is_active').notNull().default(true),
	claimedAt: timestamp('claimed_at', { withTimezone: true }),
	lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
	deletedAt: timestamp('deleted_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const userPasskeys = pgTable('user_passkeys', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	credentialId: text('credential_id').notNull().unique(),
	publicKey: text('public_key').notNull(),
	counter: integer('counter').notNull().default(0),
	transports: text('transports').array().notNull().default([]),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

export const authChallenges = pgTable('auth_challenges', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
	purpose: authChallengePurposeEnum('purpose').notNull(),
	challenge: text('challenge').notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const authSessions = pgTable('auth_sessions', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	tokenHash: text('token_hash').notNull().unique(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const bootstrapClaims = pgTable('bootstrap_claims', {
	id: uuid('id').primaryKey().defaultRandom(),
	tokenHash: text('token_hash').notNull().unique(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	usedAt: timestamp('used_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
