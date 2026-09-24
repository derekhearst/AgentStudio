import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import type { McpToolPolicy, McpToolSnapshot } from './mcp-config'

/**
 * #17 — connectors: the operator's own MCP servers, which chat runs consume.
 *
 * One row per server. HTTP and SSE only — see `./mcp-config` for why stdio is not a transport.
 *
 * `name` is the key the server is registered under in the SDK's `mcpServers`, so its tools
 * arrive as `mcp__<name>__<tool>`. It is validated (`connectorNameProblem`), unique per user and
 * never changed after create: renaming would rename every tool and orphan the usage ledger's
 * history for it. The engine keys trust on this row, never on a name the server chose.
 *
 * Secrets never sit in a readable column. The bearer token and every header value are one JSON
 * document encrypted with `APP_ENCRYPTION_KEY` (`$lib/source-control/encryption.server`);
 * `header_names` and `has_bearer_token` exist so the settings page can say what is set without
 * decrypting anything.
 */

export const mcpTransportEnum = pgEnum('mcp_transport', ['http', 'sse'])

export const mcpServers = pgTable(
	'mcp_servers',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** The SDK key and tool-name prefix. Immutable. */
		name: text('name').notNull(),
		/** What the settings page calls it. Free text. */
		label: text('label').notNull(),
		transport: mcpTransportEnum('transport').notNull(),
		url: text('url').notNull(),
		/** The custom headers' names — their values are in `encrypted_secrets`. */
		headerNames: text('header_names').array().notNull().default([]),
		hasBearerToken: boolean('has_bearer_token').notNull().default(false),
		/** `encryptSecret(serializeSecrets(...))`, or null when the connector has no secrets. */
		encryptedSecrets: text('encrypted_secrets'),
		/** Per-tool policy, by tool name as `tools/list` reported it. A tool not in here asks. */
		toolPolicies: jsonb('tool_policies').$type<Record<string, McpToolPolicy>>().notNull().default({}),
		/** What the last successful connection test listed. Display only. */
		toolsSnapshot: jsonb('tools_snapshot').$type<McpToolSnapshot[]>().notNull().default([]),
		enabled: boolean('enabled').notNull().default(true),
		/** Per-call timeout handed to the SDK. Null leaves the CLI's default. */
		timeoutMs: integer('timeout_ms'),
		lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
		lastTestOk: boolean('last_test_ok'),
		lastError: text('last_error'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		userNameUnique: unique('mcp_servers_user_name_unique').on(t.userId, t.name),
		userIdx: index('mcp_servers_user_idx').on(t.userId),
	}),
)

export type McpServerRow = typeof mcpServers.$inferSelect
