import { command, query } from '$app/server'
import { z } from 'zod'
import { getSandboxStatus as fetchSandboxStatus, webSearch } from './tools.server'
import { fileRead, shellExec } from './sandbox.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

const execSchema = z.object({
	command: z.string().trim().min(1),
})

const searchSchema = z.object({
	query: z.string().trim().min(1),
	limit: z.number().int().min(1).max(20).default(8),
})

// Nothing in the UI calls these today, but they are exported, so SvelteKit serves them —
// and `execCommand` runs a shell. An unused endpoint still needs a lock on it.
export const execCommand = command(execSchema, async (input) => {
	requireAuthenticatedRequestUser()
	const result = await shellExec(input.command)
	const success = result.exitCode === 0
	return {
		success,
		command: input.command,
		status: success ? 'completed' : 'failed',
		exitCode: result.exitCode,
		output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
		raw: result,
	}
})

export const getFileContent = query(z.string().trim().min(1), async (path) => {
	requireAuthenticatedRequestUser()
	const content = await fileRead(path)
	return { path, content }
})

export const getSandboxStatus = query(async () => {
	requireAuthenticatedRequestUser()
	return fetchSandboxStatus()
})

export const getStatus = getSandboxStatus

export const searchWeb = query(searchSchema, async (input) => {
	requireAuthenticatedRequestUser()
	return webSearch(input.query, input.limit)
})
