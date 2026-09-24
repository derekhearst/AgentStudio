import { command, query } from '$app/server'
import { z } from 'zod'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { withUserInputErrors } from '$lib/server/user-input-error'
import { hasEncryptionKey } from '$lib/source-control/encryption.server'
import {
	MAX_CONNECTOR_HEADERS,
	MAX_HEADER_VALUE_BYTES,
	MAX_TOOL_POLICIES,
	MCP_TOOL_POLICIES,
	MCP_TRANSPORTS,
	MCP_URL_MAX_LENGTH,
} from './mcp-config'
import {
	createMcpServer,
	deleteMcpServer,
	listMcpServers,
	setMcpServerEnabled,
	setMcpToolPolicies,
	testMcpServer,
	updateMcpServer,
} from './mcp.server'

/**
 * #17 — Settings → Connectors. The operator's own MCP servers: list, add, edit, test, enable,
 * disable, set each tool's policy, remove.
 *
 * Scoped to the caller on every call. The rules themselves live in `./mcp-config` and
 * `./mcp.server`, which answer a bad value with a message the form shows (`UserInputError`);
 * the schemas here only bound the sizes. No value of a secret ever comes back: the list reports
 * header names and whether a bearer token is set, and nothing else.
 */

const idSchema = z.object({ id: z.string().uuid() })

const headerName = z.string().trim().min(1).max(128)
/** Characters, a loose bound; the byte limit is checked in `./mcp-config`. */
const secretValue = z.string().max(MAX_HEADER_VALUE_BYTES)

const connectionFields = {
	label: z.string().max(200),
	transport: z.enum(MCP_TRANSPORTS),
	url: z.string().max(MCP_URL_MAX_LENGTH + 100),
	timeoutMs: z.number().int().nullable().optional(),
}

export const listMcpServersQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return {
		servers: await listMcpServers(user.id),
		/** Without it, a connector that needs a token or header cannot be saved. */
		encryptionConfigured: hasEncryptionKey(),
	}
})

const createSchema = z.object({
	...connectionFields,
	name: z.string().max(64),
	enabled: z.boolean().optional(),
	bearerToken: secretValue.nullable().optional(),
	headers: z
		.record(headerName, secretValue)
		.refine((headers) => Object.keys(headers).length <= MAX_CONNECTOR_HEADERS, 'Too many headers.')
		.optional(),
})

export const createMcpServerCommand = command(createSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	return withUserInputErrors(() => createMcpServer(user.id, input))
})

/**
 * An edit. A blank token or header value keeps the stored one; `null` removes it. The name is
 * not editable.
 */
const updateSchema = z.object({
	id: z.string().uuid(),
	label: connectionFields.label.optional(),
	transport: connectionFields.transport.optional(),
	url: connectionFields.url.optional(),
	timeoutMs: connectionFields.timeoutMs,
	bearerToken: secretValue.nullable().optional(),
	headers: z
		.record(headerName, secretValue.nullable())
		.refine((headers) => Object.keys(headers).length <= MAX_CONNECTOR_HEADERS * 2, 'Too many headers.')
		.optional(),
})

export const updateMcpServerCommand = command(updateSchema, async ({ id, ...patch }) => {
	const user = requireAuthenticatedRequestUser()
	return withUserInputErrors(() => updateMcpServer(user.id, id, patch))
})

export const setMcpServerEnabledCommand = command(
	z.object({ id: z.string().uuid(), enabled: z.boolean() }),
	async ({ id, enabled }) => {
		const user = requireAuthenticatedRequestUser()
		return withUserInputErrors(() => setMcpServerEnabled(user.id, id, enabled))
	},
)

const policiesSchema = z.object({
	id: z.string().uuid(),
	policies: z
		.record(z.string().min(1).max(128), z.enum(MCP_TOOL_POLICIES))
		.refine((policies) => Object.keys(policies).length <= MAX_TOOL_POLICIES, 'Too many tools.'),
})

export const setMcpToolPoliciesCommand = command(policiesSchema, async ({ id, policies }) => {
	const user = requireAuthenticatedRequestUser()
	return withUserInputErrors(() => setMcpToolPolicies(user.id, id, policies))
})

export const deleteMcpServerCommand = command(idSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	return withUserInputErrors(() => deleteMcpServer(user.id, id))
})

/** Connect to the saved server, list its tools, and record the outcome on the row. */
export const testMcpServerCommand = command(idSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	return withUserInputErrors(() => testMcpServer(user.id, id))
})
