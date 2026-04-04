import { env } from '$env/dynamic/private'
import {
	shellExec,
	fileRead,
	fileWrite,
	execCode as sandboxExecCode,
	browserNavigate as sandboxBrowserNavigate,
	browserScreenshot as sandboxBrowserScreenshot,
	browserClose,
} from '$lib/server/sandbox'
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

export async function readFile(path: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			path,
			content: `MOCK_FILE_CONTENT for ${path}`,
		}
	}

	const content = await fileRead(path)
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

export async function execCode(code: string, language: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			success: true,
			result: {
				language,
				stdout: `MOCK_CODE_OUTPUT: ${code.slice(0, 60)}`,
			},
		}
	}

	const result = await sandboxExecCode(code, language)
	return {
		success: result.exitCode === 0,
		result: {
			language,
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		},
	}
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
