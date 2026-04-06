import { env } from '$env/dynamic/private'
import {
	shellExec,
	fileRead,
	fileReadRange,
	fileWrite,
	filePatch,
	fileStrReplace,
	fileList,
	fileDelete,
	fileMove,
	fileSearch,
	fileInfo as sandboxFileInfo,
	browserNavigate as sandboxBrowserNavigate,
	browserScreenshot as sandboxBrowserScreenshot,
	browserClose,
} from '$lib/sandbox/client'
import { stat } from 'node:fs/promises'

export async function execShell(command: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			success: true,
			command,
			status: 'completed',
			exitCode: 0,
			output: `MOCK_SHELL_OUTPUT: ${command}`,
			raw: { mocked: true },
		}
	}

	const result = await shellExec(command)
	return {
		success: result.exitCode === 0,
		command,
		status: result.exitCode === 0 ? 'completed' : 'failed',
		exitCode: result.exitCode,
		output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
		raw: result,
	}
}

export async function readFile(path: string, startLine?: number, endLine?: number) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			path,
			content: `MOCK_FILE_CONTENT for ${path}`,
		}
	}

	const content =
		startLine !== undefined || endLine !== undefined
			? await fileReadRange(path, { startLine, endLine })
			: await fileRead(path)
	return { path, content }
}

export async function writeFile(path: string, content: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			success: true,
			path,
			message: `MOCK_FILE_WRITE (${content.length} chars)`,
		}
	}

	await fileWrite(path, content)
	return {
		success: true,
		path,
		message: `File written (${content.length} chars)`,
	}
}

export async function patchFile(patch: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			success: true,
			message: 'MOCK_PATCH_APPLIED',
		}
	}

	return filePatch(patch)
}

export async function replaceInFile(
	path: string,
	oldStr: string,
	newStr: string,
	options?: { requireUnique?: boolean; replaceAll?: boolean },
) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			path,
			replacedCount: 1,
			matchCount: 1,
			message: 'MOCK_STR_REPLACE',
		}
	}

	return fileStrReplace(path, oldStr, newStr, options)
}

export async function listDirectory(path?: string, depth = 1, includeHidden = false) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return [{ path: 'mock.txt', name: 'mock.txt', isDirectory: false, size: 10, modified: new Date().toISOString() }]
	}

	return fileList(path, { depth, includeHidden })
}

export async function deleteFile(path: string, recursive = false) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return { success: true, path, recursive, message: 'MOCK_DELETE' }
	}

	await fileDelete(path, recursive)
	return { success: true, path, recursive }
}

export async function moveFile(fromPath: string, toPath: string, overwrite = false) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return { success: true, fromPath, toPath, overwrite, message: 'MOCK_MOVE' }
	}

	const result = await fileMove(fromPath, toPath, overwrite)
	return { success: true, ...result }
}

export async function searchFiles(
	query: string,
	options?: {
		path?: string
		maxResults?: number
		isRegex?: boolean
		includeIgnored?: boolean
		caseSensitive?: boolean
	},
) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return [{ path: 'mock.txt', line: 1, preview: `MOCK_SEARCH_RESULT for ${query}` }]
	}

	return fileSearch(query, options)
}

export async function fileInfo(path: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			path,
			isDirectory: false,
			isFile: true,
			size: 123,
			modified: new Date().toISOString(),
			created: new Date().toISOString(),
			permissions: '644',
		}
	}

	return sandboxFileInfo(path)
}

export async function browserNavigate(url: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			success: true,
			url,
		}
	}

	const result = await sandboxBrowserNavigate(url)
	return {
		success: true,
		url: result.url,
		title: result.title,
	}
}

export async function browserScreenshot(url?: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			mimeType: 'image/png',
			imageBase64: '',
		}
	}

	if (url) {
		await sandboxBrowserNavigate(url)
	}
	const buffer = await sandboxBrowserScreenshot()
	return {
		mimeType: 'image/png',
		imageBase64: buffer.toString('base64'),
	}
}

export async function getSandboxStatus() {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			success: true,
			message: 'Sandbox reachable (mock)',
			stats: { mocked: true },
		}
	}

	const workspace = env.SANDBOX_WORKSPACE || '/workspace'
	try {
		const s = await stat(workspace)
		return {
			success: s.isDirectory(),
			message: s.isDirectory() ? 'Sandbox workspace accessible' : 'Sandbox workspace path is not a directory',
			stats: { workspace, isDirectory: s.isDirectory() },
		}
	} catch {
		return {
			success: false,
			message: `Sandbox workspace not found: ${workspace}`,
			stats: null,
		}
	}
}

export { browserClose }
