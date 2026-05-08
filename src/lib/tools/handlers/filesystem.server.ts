/**
 * Filesystem + sandboxed-shell tool handlers.
 *
 * These are thin orchestrators around the primitives in `sandbox-fs.server.ts` /
 * `sandbox.server.ts`: parse args via toolSchemas, call the primitive, shape the
 * result the LLM expects.
 */

import { toolSchemas } from '../tool-schemas'
import {
	fileDelete,
	fileList,
	fileMove,
	filePatch,
	fileRead,
	fileReadRange,
	fileSearch,
	fileStrReplace,
	fileWrite,
	sandboxFileInfo,
	shellExec,
} from '../sandbox.server'
import type { ToolHandler } from '../handler-types'

export const filesystemHandlers: Record<string, ToolHandler> = {
	shell: async (call, { startedAt }) => {
		const input = toolSchemas.shell.parse(call.arguments)
		const result = await shellExec(input.command)
		const success = result.exitCode === 0
		const shellResult = {
			success,
			command: input.command,
			status: success ? 'completed' : 'failed',
			exitCode: result.exitCode,
			output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
			raw: result,
		}
		return {
			success,
			tool: call.name,
			input,
			result: shellResult,
			error: success ? undefined : shellResult.output,
			executionMs: Date.now() - startedAt,
		}
	},

	file_read: async (call, { startedAt }) => {
		const input = toolSchemas.file_read.parse(call.arguments)
		const content =
			input.startLine !== undefined || input.endLine !== undefined
				? await fileReadRange(input.path, { startLine: input.startLine, endLine: input.endLine })
				: await fileRead(input.path)
		return {
			success: true,
			tool: call.name,
			input,
			result: { path: input.path, content },
			executionMs: Date.now() - startedAt,
		}
	},

	file_write: async (call, { startedAt }) => {
		const input = toolSchemas.file_write.parse(call.arguments)
		await fileWrite(input.path, input.content)
		return {
			success: true,
			tool: call.name,
			input,
			result: {
				success: true,
				path: input.path,
				message: `File written (${input.content.length} chars)`,
			},
			executionMs: Date.now() - startedAt,
		}
	},

	file_patch: async (call, { startedAt }) => {
		const input = toolSchemas.file_patch.parse(call.arguments)
		return {
			success: true,
			tool: call.name,
			input,
			result: await filePatch(input.patch),
			executionMs: Date.now() - startedAt,
		}
	},

	file_replace: async (call, { startedAt }) => {
		const input = toolSchemas.file_replace.parse(call.arguments)
		return {
			success: true,
			tool: call.name,
			input,
			result: await fileStrReplace(input.path, input.oldStr, input.newStr, {
				requireUnique: input.requireUnique,
				replaceAll: input.replaceAll,
			}),
			executionMs: Date.now() - startedAt,
		}
	},

	list_directory: async (call, { startedAt }) => {
		const input = toolSchemas.list_directory.parse(call.arguments)
		return {
			success: true,
			tool: call.name,
			input,
			result: await fileList(input.path, {
				depth: input.depth,
				includeHidden: input.includeHidden,
			}),
			executionMs: Date.now() - startedAt,
		}
	},

	delete_file: async (call, { startedAt }) => {
		const input = toolSchemas.delete_file.parse(call.arguments)
		await fileDelete(input.path, input.recursive)
		return {
			success: true,
			tool: call.name,
			input,
			result: { success: true, path: input.path, recursive: input.recursive },
			executionMs: Date.now() - startedAt,
		}
	},

	move_file: async (call, { startedAt }) => {
		const input = toolSchemas.move_file.parse(call.arguments)
		const moved = await fileMove(input.fromPath, input.toPath, input.overwrite)
		return {
			success: true,
			tool: call.name,
			input,
			result: { success: true, ...moved },
			executionMs: Date.now() - startedAt,
		}
	},

	search_files: async (call, { startedAt }) => {
		const input = toolSchemas.search_files.parse(call.arguments)
		return {
			success: true,
			tool: call.name,
			input,
			result: await fileSearch(input.query, {
				path: input.path,
				maxResults: input.maxResults,
				isRegex: input.isRegex,
				includeIgnored: input.includeIgnored,
				caseSensitive: input.caseSensitive,
			}),
			executionMs: Date.now() - startedAt,
		}
	},

	file_info: async (call, { startedAt }) => {
		const input = toolSchemas.file_info.parse(call.arguments)
		return {
			success: true,
			tool: call.name,
			input,
			result: await sandboxFileInfo(input.path),
			executionMs: Date.now() - startedAt,
		}
	},
}
