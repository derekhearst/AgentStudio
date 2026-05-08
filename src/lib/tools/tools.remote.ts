import { command, query } from '$app/server'
import { z } from 'zod'
import { getSandboxStatus as fetchSandboxStatus, webSearch } from './tools.server'
import { fileRead, shellExec } from './sandbox.server'

const execSchema = z.object({
	command: z.string().trim().min(1),
})

const searchSchema = z.object({
	query: z.string().trim().min(1),
	limit: z.number().int().min(1).max(20).default(8),
})

export const execCommand = command(execSchema, async (input) => {
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
	const content = await fileRead(path)
	return { path, content }
})

export const getSandboxStatus = query(async () => {
	return fetchSandboxStatus()
})

export const getStatus = getSandboxStatus

export const searchWeb = query(searchSchema, async (input) => {
	return webSearch(input.query, input.limit)
})
