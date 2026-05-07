import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { ensureWorkspaceDir, getWorkspace, toolUserContext } from './sandbox.server'
import { executeToolWithApproval } from '$lib/runtime/approval.server'
import { logger } from '$lib/observability/logger'
import { normalizeToolName } from './tool-schemas'

/**
 * Programmatic tool calling.
 *
 * The model gets one tool, `run_code`, that runs JavaScript in a Bun sandbox subprocess. Inside
 * the script every tool currently exposed to the model is reachable as `await tools.<name>(args)` —
 * the script POSTs to a single-use, ephemeral 127.0.0.1 listener owned by the parent process,
 * which validates a per-call bearer token and forwards the call through `executeToolWithApproval`.
 * That means approvals, mandatory-approval tools, capability filtering, and per-agent policies all
 * still apply to anything the script does — the script does not bypass any policy, it just lets
 * the model batch many tool calls into one round-trip.
 *
 * Cross-platform: uses `node:http` + `node:child_process.spawn` so it works on Windows dev and
 * Linux/Docker prod.
 */

export type RunCodeInput = {
	code: string
	timeoutMs?: number
}

export type RunCodeResult = {
	stdout: string
	stderr: string
	exitCode: number | null
	returnValue?: unknown
	timedOut: boolean
	durationMs: number
	toolCallCount: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024
const MAX_CONCURRENT_RPC = 8

/**
 * Tools the script is never allowed to call:
 *  - `run_code` itself, to avoid recursion + listener leaks.
 *  - `ask_user`, because it requires the orchestrator's question-routing path.
 *  - `enable_capability`, because the script's tool list is frozen at start; calling it from
 *    inside the script wouldn't surface the new tools until the next round anyway.
 *  - `run_subagent`, because the loop's special-case dispatch wraps it in subagent setup.
 */
const SCRIPT_DISALLOWED_TOOLS = new Set(['run_code', 'ask_user', 'enable_capability', 'run_subagent'])

export async function runCodeTool(input: RunCodeInput): Promise<RunCodeResult> {
	const ctx = toolUserContext.getStore()
	if (!ctx?.userId) {
		throw new Error('run_code requires a tool user context (userId)')
	}
	if (!ctx.runId) {
		throw new Error('run_code requires an active run (runId)')
	}
	if (!ctx.runtime) {
		throw new Error(
			'run_code requires runtime context (session, approvalRequiredTools, currentToolNames). It can only be invoked from inside the chat loop.',
		)
	}

	const startedAt = Date.now()
	const timeoutMs = clampTimeout(input.timeoutMs)

	await ensureWorkspaceDir()
	const workspace = getWorkspace()
	const callId = randomUUID()
	const callDir = join(workspace, '.run-code', callId)
	await mkdir(callDir, { recursive: true })

	const bootstrapPath = join(callDir, 'bootstrap.mjs')
	const userCodePath = join(callDir, 'user.mjs')
	const returnPath = join(callDir, 'return.json')

	const enabledTools = ctx.runtime.currentToolNames().filter((name) => !SCRIPT_DISALLOWED_TOOLS.has(name))

	const token = randomBytes(32).toString('hex')
	let toolCallCount = 0
	let inflight = 0

	// Snapshot the runtime + workspace context — the HTTP handler runs in a separate async scope
	// so we cannot rely on AsyncLocalStorage to forward it.
	const captured = {
		userId: ctx.userId,
		runId: ctx.runId,
		persistentKey: ctx.persistentKey ?? null,
		worktree: ctx.worktree ?? null,
		approvalRequiredTools: ctx.runtime.approvalRequiredTools,
		session: ctx.runtime.session ?? null,
	}

	const server = await startRpcServer({
		token,
		onCall: async (rawName, rawArgs) => {
			if (inflight >= MAX_CONCURRENT_RPC) {
				return { error: `run_code concurrency cap (${MAX_CONCURRENT_RPC}) exceeded` }
			}
			inflight++
			try {
				const normalized = normalizeToolName(rawName)
				if (!normalized) return { error: `unknown tool: ${rawName}` }
				if (SCRIPT_DISALLOWED_TOOLS.has(normalized)) {
					return {
						error: `tool ${normalized} cannot be called from run_code (disallowed: ${[...SCRIPT_DISALLOWED_TOOLS].join(', ')})`,
					}
				}
				if (!enabledTools.includes(normalized)) {
					return {
						error: `tool ${normalized} is not currently enabled — call enable_capability(...) from a normal tool round first`,
					}
				}
				toolCallCount++
				const nestedCallId = `runcode-${callId.slice(0, 8)}-${toolCallCount}`
				const outcome = await executeToolWithApproval({
					call: {
						name: normalized as Parameters<typeof executeToolWithApproval>[0]['call']['name'],
						arguments: rawArgs,
					},
					userId: captured.userId,
					runId: captured.runId,
					toolCallId: nestedCallId,
					approvalRequiredTools: captured.approvalRequiredTools,
					session: captured.session,
					workspace: { persistentKey: captured.persistentKey, worktree: captured.worktree },
				})
				if (outcome.denied) return { denied: true }
				const r = outcome.result
				if (r.success) return { success: true, result: r.result }
				return { error: r.error ?? 'tool failed' }
			} catch (err) {
				logger.warn('[run_code] tool dispatch error', { err })
				return { error: err instanceof Error ? err.message : String(err) }
			} finally {
				inflight--
			}
		},
	})

	const port = (server.address() as { port: number }).port

	try {
		await writeFile(userCodePath, input.code, 'utf-8')
		await writeFile(bootstrapPath, BOOTSTRAP_SOURCE, 'utf-8')

		const env: Record<string, string> = {
			PATH: process.env.PATH ?? '',
			SYSTEMROOT: process.env.SYSTEMROOT ?? '',
			SYSTEMDRIVE: process.env.SYSTEMDRIVE ?? '',
			HOME: workspace,
			USERPROFILE: workspace,
			TMPDIR: join(workspace, '.tmp'),
			TMP: join(workspace, '.tmp'),
			TEMP: join(workspace, '.tmp'),
			SANDBOX_ROOT: workspace,
			NPM_CONFIG_CACHE: join(workspace, '.npm-cache'),
			BUN_INSTALL_CACHE_DIR: join(workspace, '.bun-cache'),
			NODE_PATH: '',
			AS_RUNCODE_TOKEN: token,
			AS_RUNCODE_PORT: String(port),
			AS_RUNCODE_HOST: '127.0.0.1',
			AS_RUNCODE_TOOLS: JSON.stringify(enabledTools),
			AS_RUNCODE_USER_CODE_FILE: userCodePath,
			AS_RUNCODE_RETURN_FILE: returnPath,
		}
		await mkdir(env.TMPDIR, { recursive: true })

		const child = spawn('bun', ['run', bootstrapPath], {
			cwd: workspace,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		})

		let stdout = ''
		let stderr = ''
		let stdoutTruncated = false
		let stderrTruncated = false

		child.stdout?.on('data', (chunk: Buffer) => {
			if (stdout.length >= MAX_OUTPUT_BYTES) {
				stdoutTruncated = true
				return
			}
			stdout += chunk.toString('utf-8')
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			if (stderr.length >= MAX_OUTPUT_BYTES) {
				stderrTruncated = true
				return
			}
			stderr += chunk.toString('utf-8')
		})

		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			try {
				child.kill('SIGKILL')
			} catch {
				/* noop */
			}
		}, timeoutMs)

		const exitCode = await new Promise<number | null>((resolve) => {
			child.on('exit', (code) => resolve(code))
			child.on('error', (err) => {
				stderr += `\n[run_code spawn error] ${err.message}`
				resolve(null)
			})
		})
		clearTimeout(timer)

		if (stdoutTruncated) stdout += `\n[run_code stdout truncated at ${MAX_OUTPUT_BYTES} bytes]`
		if (stderrTruncated) stderr += `\n[run_code stderr truncated at ${MAX_OUTPUT_BYTES} bytes]`

		let returnValue: unknown
		try {
			const raw = await readFile(returnPath, 'utf-8')
			returnValue = JSON.parse(raw)
		} catch {
			returnValue = undefined
		}

		return {
			stdout,
			stderr,
			exitCode,
			returnValue,
			timedOut,
			durationMs: Date.now() - startedAt,
			toolCallCount,
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()))
		// Best-effort cleanup of the per-call dir. Leave it on failure for forensics if NODE_ENV=development.
		if (process.env.NODE_ENV === 'production') {
			try {
				await rm(callDir, { recursive: true, force: true })
			} catch {
				/* noop */
			}
		}
	}
}

function clampTimeout(timeoutMs: number | undefined): number {
	if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS
	return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(timeoutMs)))
}

type RpcResponse = { success: true; result: unknown } | { denied: true } | { error: string }

async function startRpcServer(opts: {
	token: string
	onCall: (toolName: string, args: unknown) => Promise<RpcResponse>
}): Promise<Server> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void handleRequest(req, res, opts).catch((err: unknown) => {
			logger.warn('[run_code] RPC handler error', { err })
			if (!res.headersSent) {
				res.statusCode = 500
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify({ error: 'internal_error' }))
			}
		})
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen({ host: '127.0.0.1', port: 0 }, () => resolve())
	})
	return server
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	opts: { token: string; onCall: (toolName: string, args: unknown) => Promise<RpcResponse> },
): Promise<void> {
	if (req.method !== 'POST' || req.url !== '/tool') {
		res.statusCode = 404
		res.setHeader('content-type', 'application/json')
		res.end(JSON.stringify({ error: 'not_found' }))
		return
	}
	const auth = req.headers.authorization ?? ''
	const expected = `Bearer ${opts.token}`
	if (!constantTimeEqual(auth, expected)) {
		res.statusCode = 401
		res.setHeader('content-type', 'application/json')
		res.end(JSON.stringify({ error: 'unauthorized' }))
		return
	}
	const bodyStr = await readBody(req)
	let body: { name?: unknown; arguments?: unknown }
	try {
		body = JSON.parse(bodyStr) as { name?: unknown; arguments?: unknown }
	} catch {
		res.statusCode = 400
		res.setHeader('content-type', 'application/json')
		res.end(JSON.stringify({ error: 'invalid_json' }))
		return
	}
	if (typeof body?.name !== 'string') {
		res.statusCode = 400
		res.setHeader('content-type', 'application/json')
		res.end(JSON.stringify({ error: 'missing_name' }))
		return
	}
	const result = await opts.onCall(body.name, body.arguments ?? {})
	res.statusCode = 200
	res.setHeader('content-type', 'application/json')
	res.end(JSON.stringify(result))
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = ''
		let total = 0
		const MAX = 4 * 1024 * 1024
		req.on('data', (chunk: Buffer) => {
			total += chunk.length
			if (total > MAX) {
				reject(new Error('body too large'))
				req.destroy()
				return
			}
			buf += chunk.toString('utf-8')
		})
		req.on('end', () => resolve(buf))
		req.on('error', reject)
	})
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let mismatch = 0
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return mismatch === 0
}

const BOOTSTRAP_SOURCE = `import { readFile, writeFile } from 'node:fs/promises'

const TOKEN = process.env.AS_RUNCODE_TOKEN
const PORT = Number(process.env.AS_RUNCODE_PORT)
const HOST = process.env.AS_RUNCODE_HOST ?? '127.0.0.1'
const ENABLED = JSON.parse(process.env.AS_RUNCODE_TOOLS ?? '[]')
const RETURN_FILE = process.env.AS_RUNCODE_RETURN_FILE
const USER_CODE_FILE = process.env.AS_RUNCODE_USER_CODE_FILE

async function rpc(name, args) {
  const r = await fetch(\`http://\${HOST}:\${PORT}/tool\`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: \`Bearer \${TOKEN}\`,
    },
    body: JSON.stringify({ name, arguments: args ?? {} }),
  })
  const text = await r.text()
  let body
  try { body = JSON.parse(text) } catch { throw new Error(\`tool \${name}: non-JSON response: \${text.slice(0, 200)}\`) }
  if (body.denied) throw new Error(\`tool \${name}: denied by user\`)
  if (body.error) throw new Error(\`tool \${name}: \${body.error}\`)
  if (!body.success) throw new Error(\`tool \${name}: failed\`)
  return body.result
}

const tools = Object.fromEntries(ENABLED.map((n) => [n, (args) => rpc(n, args ?? {})]))
tools.list = () => ENABLED.slice()

const userCode = await readFile(USER_CODE_FILE, 'utf-8')
const AsyncFunction = (async () => {}).constructor

let returnValue
try {
  const fn = new AsyncFunction('tools', 'rpc', userCode)
  returnValue = await fn(tools, rpc)
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err))
  process.exit(1)
}

if (returnValue !== undefined) {
  try {
    await writeFile(RETURN_FILE, JSON.stringify(returnValue))
  } catch (err) {
    await writeFile(RETURN_FILE, JSON.stringify({ __unserializable: true, message: String(err) }))
  }
}
`
