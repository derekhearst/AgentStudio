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
