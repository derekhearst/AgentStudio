/**
 * #24 — a short-lived SDK session that exists only to rewind files.
 *
 * `Query.rewindFiles(userMessageId, { dryRun })` restores the files a session's tools
 * changed to how they were at one of its user messages, and with `dryRun` reports what it
 * would change without touching anything. It is a control request, so it needs a live
 * `Query` — and a rewind is asked for between turns, when the turn's own `Query` is gone.
 * The run registry cannot help either: it is per process, and a restart empties it.
 *
 * So a rewind opens its own session: `query()` resuming the conversation's SDK session, in
 * the same working directory the runs used, with file checkpointing on, and an input that
 * never yields. No user message ever arrives, so the model is never called. The request is
 * answered from the file history the CLI loads from the transcript at start-up, and the
 * session is closed straight after — on success, on failure and on timeout alike.
 *
 * What was checked against the SDK and the bundled CLI (`@anthropic-ai/claude-agent-sdk`
 * 0.3.278), rather than assumed:
 *
 * - `enableFileCheckpointing` reaches the CLI as `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`,
 *   which the SDK sets on the child's environment itself, after `env` — so the engine's env
 *   allow-list does not have to name it.
 * - In print mode the CLI loads a resumed session, file-history snapshots included, before
 *   it reads any input, and answers `rewind_files` from that state. With checkpointing off
 *   it answers "File rewinding is not enabled."; for a message it holds no snapshot of,
 *   "No file checkpoint found for this message."
 * - A dry run reports `filesChanged` as absolute paths: tracked paths are stored relative
 *   to the CLI's working directory when they sit under it, and made absolute against it
 *   again. That is why the working directory has to be the run's own.
 * - A real rewind that fails comes back as a control error, which the SDK throws; a dry run
 *   that cannot rewind resolves with `canRewind: false` and the reason.
 * - `forkSession()` copies no file history, which is one reason edits never fork.
 */

import {
	query,
	type Options,
	type PermissionResult,
	type RewindFilesResult,
	type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { buildEngineEnv } from './engine-env'
import { resultErrorMessage } from './run-result'

export type { RewindFilesResult }

/** The slice of the SDK's `Query` a control session uses. A spec supplies a stub. */
export type RewindControlSource = AsyncIterable<unknown> & {
	rewindFiles: (userMessageId: string, options?: { dryRun?: boolean }) => Promise<RewindFilesResult>
	close: () => void
}

export type CreateRewindQuery = (params: {
	prompt: AsyncIterable<SDKUserMessage>
	options: Options
}) => RewindControlSource

/** What the work inside a control session may do. */
export type RewindControl = {
	rewindFiles: (userMessageId: string, options?: { dryRun?: boolean }) => Promise<RewindFilesResult>
}

/**
 * Spawning the CLI and loading a long transcript takes a few seconds; a rewind that has not
 * answered in this long is not going to, and the user is waiting on a dialog.
 */
export const CONTROL_SESSION_TIMEOUT_MS = 30_000

export class RewindTimeoutError extends Error {
	constructor(ms: number) {
		super(`Restoring files did not answer within ${Math.round(ms / 1000)} seconds.`)
		this.name = 'RewindTimeoutError'
	}
}

export type ControlSessionInput = {
	/** The SDK session to resume — the conversation's `sdk_session_id`. */
	sessionId: string
	/** The working directory the checkpointed run used. Nothing else resolves its paths right. */
	cwd: string
	/** The CLI's environment. Defaults to the engine's allow-list, the same one runs get. */
	env?: Record<string, string>
	createQuery?: CreateRewindQuery
	timeoutMs?: number
}

/**
 * Options for a session that can do nothing but answer control requests: no tools, no MCP
 * servers, no settings from disk, and a permission callback that refuses anything that asks.
 * `maxTurns` is belt and braces — no prompt is ever sent.
 */
export function controlSessionOptions(input: Pick<ControlSessionInput, 'sessionId' | 'cwd' | 'env'>): Options {
	return {
		resume: input.sessionId,
		cwd: input.cwd,
		enableFileCheckpointing: true,
		settingSources: [],
		tools: [],
		mcpServers: {},
		strictMcpConfig: true,
		permissionMode: 'default',
		canUseTool: async (): Promise<PermissionResult> => ({
			behavior: 'deny',
			message: 'This session only restores files.',
		}),
		maxTurns: 1,
		env: input.env ?? buildEngineEnv(process.env),
	}
}

/**
 * An input stream that never yields a message and ends when `stop` is called.
 *
 * The SDK keeps the CLI's stdin open until its input ends, and control requests travel on
 * stdin — so this is what keeps the session answerable for exactly as long as it is needed.
 */
export function idleInput(): { input: AsyncIterable<SDKUserMessage>; stop: () => void } {
	let stop: () => void = () => {}
	const stopped = new Promise<void>((resolve) => (stop = resolve))
	async function* never(): AsyncGenerator<SDKUserMessage> {
		await stopped
	}
	return { input: never(), stop: () => stop() }
}

/**
 * Open a control session, hand it to `work`, and close it whatever happens.
 *
 * The session's messages are drained in the background — nothing here needs them, but the
 * CLI's start-up failure (a session it cannot find, say) arrives as an error result, and it
 * is a far better message than the SDK's "process exited".
 */
export async function withControlSession<T>(
	input: ControlSessionInput,
	work: (control: RewindControl) => Promise<T>,
): Promise<T> {
	const timeoutMs = input.timeoutMs ?? CONTROL_SESSION_TIMEOUT_MS
	const idle = idleInput()
	const create: CreateRewindQuery =
		input.createQuery ?? ((params) => query(params) as unknown as RewindControlSource)
	let session: RewindControlSource
	try {
		session = create({ prompt: idle.input, options: controlSessionOptions(input) })
	} catch (error) {
		idle.stop()
		throw error
	}

	let startupError: string | null = null
	const drained = (async () => {
		try {
			for await (const message of session) {
				const msg = message as Record<string, unknown> | null
				if (msg?.type === 'result') startupError = resultErrorMessage(msg) ?? startupError
			}
		} catch {
			// The session ending badly shows up as a failed request below.
		}
	})()

	let closed = false
	const closeSession = () => {
		if (closed) return
		closed = true
		idle.stop()
		try {
			session.close()
		} catch {
			// Already gone.
		}
	}

	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			work({ rewindFiles: (id, options) => session.rewindFiles(id, options) }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new RewindTimeoutError(timeoutMs)), timeoutMs)
			}),
		])
	} catch (error) {
		if (error instanceof RewindTimeoutError) throw error
		// A CLI that could not start writes its reason as an error result just before it exits,
		// which can land a moment after the request failed. Give the drain a moment to read it.
		closeSession()
		await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 1_000))])
		throw startupError ? new Error(startupError) : error
	} finally {
		clearTimeout(timer)
		closeSession()
	}
}
