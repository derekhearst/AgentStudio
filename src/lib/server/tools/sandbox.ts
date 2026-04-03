import { SandboxClient } from '@agent-infra/sandbox'
import { env } from '$env/dynamic/private'

let sandboxClient: SandboxClient | null = null

function getClient() {
	if (!env.SANDBOX_URL) {
		throw new Error('SANDBOX_URL is not configured')
	}
	if (!sandboxClient) {
		sandboxClient = new SandboxClient({
			environment: env.SANDBOX_URL,
		})
	}
	return sandboxClient
}

function getErrorMessage(error: unknown) {
	if (error && typeof error === 'object') {
		if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
			return (error as { message: string }).message
		}
		return JSON.stringify(error)
	}
	return 'Sandbox request failed'
}

function assertOk<Success>(response: { ok: boolean; body?: Success; error?: unknown }) {
	if (!response.ok) {
		throw new Error(getErrorMessage(response.error))
	}
	return response.body as Success
}

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

	const client = getClient()
	const response = await client.shell.execCommand({
		command,
		async_mode: false,
		timeout: 120,
	})
	const body = assertOk(response)
	const result = body.data
	return {
		success: body.success ?? true,
		command,
		status: result?.status ?? 'unknown',
		exitCode: result?.exit_code ?? null,
		output: result?.output ?? '',
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

	const client = getClient()
	const response = await client.file.readFile({ file: path })
	const body = assertOk(response)
	return {
		path,
		content: body.data?.content ?? '',
	}
}

export async function writeFile(path: string, content: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			success: true,
			path,
			message: `MOCK_FILE_WRITE (${content.length} chars)`,
		}
	}

	const client = getClient()
	const response = await client.file.writeFile({ file: path, content })
	const body = assertOk(response)
	return {
		success: body.success ?? true,
		path,
		message: body.message ?? 'File written',
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

	const client = getClient()
	const response = await client.code.executeCode({
		language: language as never,
		code,
	})
	const body = assertOk(response)
	return {
		success: body.success ?? true,
		result: body.data,
	}
}

export async function browserNavigate(url: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			success: true,
			url,
		}
	}

	const client = getClient()
	const response = await client.browserPage.navigate({ url })
	const body = assertOk(response)
	return {
		success: body.success ?? true,
		url,
	}
}

export async function browserScreenshot(url?: string) {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return {
			mimeType: 'image/png',
			imageBase64: '',
		}
	}

	const client = getClient()
	if (url) {
		await browserNavigate(url)
	}
	const response = await client.browserPage.screenshot({ full_page: true, format: 'png' })
	const body = assertOk(response)
	const buffer = Buffer.from(await body.arrayBuffer())
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

	const client = getClient()
	const response = await client.shell.getSessionStats()
	const body = assertOk(response)
	return {
		success: body.success ?? true,
		message: body.message ?? 'Sandbox reachable',
		stats: body.data ?? null,
	}
}
