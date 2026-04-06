import { command, query } from '$app/server'
import { z } from 'zod'
import { execShell, getSandboxStatus as fetchSandboxStatus, readFile, webSearch } from './tools.server'

const execSchema = z.object({
	command: z.string().trim().min(1),
})

const searchSchema = z.object({
	query: z.string().trim().min(1),
	limit: z.number().int().min(1).max(20).default(8),
})

export const execCommand = command(execSchema, async (input) => {
	return execShell(input.command)
})

export const getFileContent = query(z.string().trim().min(1), async (path) => {
	return readFile(path)
})

export const getSandboxStatus = query(async () => {
	return fetchSandboxStatus()
})

export const getStatus = getSandboxStatus

export const searchWeb = query(searchSchema, async (input) => {
	return webSearch(input.query, input.limit)
})
