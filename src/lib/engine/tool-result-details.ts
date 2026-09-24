/**
 * Distils the Agent SDK's structured tool output into small, renderable payloads.
 *
 * The SDK answers a tool call with two things: the text the *model* reads, on
 * `message.content[].tool_result`, and the tool's full typed Output object, on
 * `SDKUserMessage.tool_use_result`. Until this module existed the engine read only the
 * first one and flattened it to a string, so an `Edit` — which arrives carrying a computed
 * unified diff — reached the chat as JSON-escaped prose. That is the whole reason diffs,
 * terminal output and the todo list all looked like generic tool cards (#16, #26, #21).
 *
 * What this does NOT do is store the SDK's payload as-is. Two tables take these blocks as
 * jsonb (`chat_runs.stream_blocks` and `messages.metadata`), so a `Write` of a 4 MB file
 * would otherwise persist its entire previous contents on every turn, twice. Everything
 * here is capped, and anything dropped sets `truncated` so the UI can say so rather than
 * quietly showing half a diff.
 *
 * Shapes are read defensively on purpose. `tool_use_result` is typed `unknown`, the field
 * set varies with the CLI version behind the SDK, and a tool that returns something
 * unexpected must degrade to "no details, render the old card" — never throw, because this
 * runs inside the stream loop where an exception would kill the turn.
 *
 * Deliberately not consumed yet, but present on `BashOutput` if someone wants it:
 * `gitOperation`, a structured classification of any git/gh command (commit sha, push
 * branch, PR number + action) that the SDK documents as client-facing so a UI can render
 * git activity without re-parsing stdout.
 *
 * Pure and dependency-free, like `./builtin-tools`: imported by the engine, by the chat
 * page, and by specs running in the plain Playwright loader where `$lib` and `$env` do not
 * resolve.
 */

/** Total diff lines kept across all hunks of one edit. Beyond this the edit is truncated. */
export const MAX_DIFF_LINES = 400

/** Characters kept per output stream. The tail is kept — a failing command explains itself at the end. */
export const MAX_STREAM_CHARS = 16_000

/** Todo items kept. A list longer than this is a runaway, not a plan. */
export const MAX_TODO_ITEMS = 100

/**
 * Characters of a child agent's final report kept on its card. The whole report went to the
 * parent model already; this copy is for a person skimming the transcript, and the child's
 * forwarded text usually carries the same words.
 */
export const MAX_REPORT_CHARS = 4_000

/** One hunk of a unified diff, in the shape the SDK computes it. */
export type DiffHunk = {
	oldStart: number
	oldLines: number
	newStart: number
	newLines: number
	lines: string[]
}

/** Why an edit has no diff to show. `none` means it has one. */
export type DiffUnavailable = 'none' | 'no_change' | 'diff_missing'

export type FileEditDetails = {
	kind: 'file_edit'
	/** The built-in that produced it: Edit, MultiEdit or Write. */
	tool: string
	path: string
	changeType: 'create' | 'update'
	hunks: DiffHunk[]
	additions: number
	deletions: number
	/**
	 * Set when `hunks` is empty and that is not a bug: `no_change` for a write that changed
	 * nothing, `diff_missing` when the SDK could not produce one (it documents an empty
	 * patch for a diff that timed out, and a null `originalFile` when the previous contents
	 * were too large to include).
	 */
	unavailable: DiffUnavailable
	/** True when hunks were dropped to stay inside `MAX_DIFF_LINES`. */
	truncated: boolean
}

export type ShellDetails = {
	kind: 'shell'
	/** Bash, BashOutput or KillShell. */
	tool: string
	command: string | null
	/** The model's own one-line description of the command, when it supplied one. */
	description: string | null
	stdout: string
	stderr: string
	interrupted: boolean
	/** Present when the command was backgrounded; the handle `BashOutput` / `KillShell` take. */
	backgroundTaskId: string | null
	/** Set when the command hit its timeout and the CLI auto-backgrounded it. */
	timedOutAfterMs: number | null
	/** Where the CLI spilled the full output when it was too large to inline. */
	persistedOutputPath: string | null
	/** True when either stream was clipped to `MAX_STREAM_CHARS` (the tail is what was kept). */
	truncated: boolean
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type TodoItem = {
	content: string
	status: TodoStatus
	/** Present-tense form the SDK carries for the in-progress item ("Running the tests"). */
	activeForm: string | null
}

export type TodoDetails = {
	kind: 'todo'
	items: TodoItem[]
	completed: number
	total: number
	/** True when items were dropped to stay inside `MAX_TODO_ITEMS`. */
	truncated: boolean
}

/** Token counts in the ledger's own vocabulary, read off the SDK's `usage` object. */
export type SubagentUsage = {
	inputTokens: number
	outputTokens: number
	cacheCreationTokens: number
	cacheReadTokens: number
}

/**
 * A delegated child's result (#32) — the SDK's `AgentOutput` for the `Agent` / `Task` tool.
 *
 * `completed` is a foreground child that ran to the end, with its report and run totals.
 * `async_launched` and `remote_launched` are the placeholders a background or remote child
 * answers with immediately; the delegation gate forces foreground, so they should not occur,
 * but they are recognised so the card can say what happened instead of claiming a result.
 *
 * `usage` and `totalTokens` are what the SDK reports, and it is worth being exact about what
 * that is: the bundled CLI (2.1.278) fills both from the child's LAST model call — `usage` is
 * that call's usage object and `totalTokens` its input, cache and output tokens added up,
 * which is the child's context size at the end plus its final answer. They are not the sum
 * of everything the child spent. The ledger treats them accordingly (`$lib/costs/subagent-ledger`).
 */
export type SubagentDetails = {
	kind: 'subagent'
	/** `Agent`, or `Task` from an older CLI. */
	tool: string
	status: 'completed' | 'async_launched' | 'remote_launched'
	/** The SDK's id for the child — what its transcript file is named after. */
	sdkAgentId: string | null
	/** The agent key it ran as (`subagent_type`), as the SDK resolved it. */
	agentType: string | null
	/** The child's final report, capped at `MAX_REPORT_CHARS`. Empty for a launch placeholder. */
	report: string
	reportTruncated: boolean
	totalTokens: number | null
	totalToolUseCount: number | null
	totalDurationMs: number | null
	/** The child's final model call's usage — see the type note. Null when not reported. */
	usage: SubagentUsage | null
	/** The model the child ended on. */
	resolvedModel: string | null
}

export type ToolResultDetails = FileEditDetails | ShellDetails | TodoDetails | SubagentDetails

/** Built-ins whose output this module knows how to distil. */
const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit'])
const FILE_WRITE_TOOLS = new Set(['Write'])
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell'])
/** Both spellings of the delegation tool; duplicated from `./builtin-tools` to stay import-free. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

export function hasToolResultDetails(toolName: string): boolean {
	return (
		FILE_EDIT_TOOLS.has(toolName) ||
		FILE_WRITE_TOOLS.has(toolName) ||
		SHELL_TOOLS.has(toolName) ||
		SUBAGENT_TOOLS.has(toolName) ||
		toolName === 'TodoWrite'
	)
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Keep the tail of an over-long stream; the end is where a failing command explains itself. */
function clipTail(value: unknown): { text: string; truncated: boolean } {
	if (typeof value !== 'string' || value.length === 0) return { text: '', truncated: false }
	if (value.length <= MAX_STREAM_CHARS) return { text: value, truncated: false }
	return { text: value.slice(value.length - MAX_STREAM_CHARS), truncated: true }
}

function readHunks(value: unknown): DiffHunk[] {
	if (!Array.isArray(value)) return []
	const hunks: DiffHunk[] = []
	for (const entry of value) {
		const hunk = asRecord(entry)
		if (!hunk) continue
		const lines = Array.isArray(hunk.lines)
			? hunk.lines.filter((line): line is string => typeof line === 'string')
			: []
		if (lines.length === 0) continue
		hunks.push({
			oldStart: num(hunk.oldStart) ?? 0,
			oldLines: num(hunk.oldLines) ?? 0,
			newStart: num(hunk.newStart) ?? 0,
			newLines: num(hunk.newLines) ?? 0,
			lines,
		})
	}
	return hunks
}

/** Drop whole hunks past the line budget rather than cutting one in half. */
function capHunks(hunks: DiffHunk[]): { hunks: DiffHunk[]; truncated: boolean } {
	let budget = MAX_DIFF_LINES
	const kept: DiffHunk[] = []
	for (const hunk of hunks) {
		if (hunk.lines.length > budget) return { hunks: kept, truncated: true }
		kept.push(hunk)
		budget -= hunk.lines.length
	}
	return { hunks: kept, truncated: false }
}

/** Count +/- lines across the hunks we kept. Used only when the SDK gave us no git counts. */
function countChanges(hunks: DiffHunk[]): { additions: number; deletions: number } {
	let additions = 0
	let deletions = 0
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.startsWith('+')) additions++
			else if (line.startsWith('-')) deletions++
		}
	}
	return { additions, deletions }
}

function fileEditDetails(
	toolName: string,
	result: Record<string, unknown>,
	args: Record<string, unknown> | null,
): FileEditDetails | null {
	const path = str(result.filePath) ?? str(args?.file_path) ?? str(args?.path)
	if (!path) return null

	const all = readHunks(result.structuredPatch)
	const { hunks, truncated } = capHunks(all)

	// `type` is FileWriteOutput's own field; Edit has no equivalent, and an edit by
	// definition changes a file that already existed.
	const changeType = str(result.type) === 'create' ? 'create' : 'update'

	const gitDiff = asRecord(result.gitDiff)
	const counted = countChanges(hunks)
	// Prefer git's counts: they describe the whole change even when hunks were dropped.
	const additions = num(gitDiff?.additions) ?? counted.additions
	const deletions = num(gitDiff?.deletions) ?? counted.deletions

	let unavailable: DiffUnavailable = 'none'
	if (all.length === 0) {
		// An empty patch with the original contents in hand means nothing actually changed.
		// An empty patch with `originalFile: null` on an update means the SDK could not
		// produce one — a diff that timed out, or previous contents too large to include.
		unavailable = changeType === 'update' && result.originalFile === null ? 'diff_missing' : 'no_change'
	}

	return {
		kind: 'file_edit',
		tool: toolName,
		path,
		changeType,
		hunks,
		additions,
		deletions,
		unavailable,
		truncated,
	}
}

function shellDetails(
	toolName: string,
	result: Record<string, unknown>,
	args: Record<string, unknown> | null,
): ShellDetails | null {
	const stdout = clipTail(result.stdout)
	const stderr = clipTail(result.stderr)

	// A shell result with no output at all is still worth a terminal card — "exited with
	// nothing to say" is information — but only if the payload really was a shell payload.
	// Absent every known field it is something else wearing the name, so decline.
	const recognised =
		'stdout' in result || 'stderr' in result || 'interrupted' in result || 'backgroundTaskId' in result
	if (!recognised) return null

	return {
		kind: 'shell',
		tool: toolName,
		command: str(args?.command),
		description: str(args?.description),
		stdout: stdout.text,
		stderr: stderr.text,
		interrupted: result.interrupted === true,
		backgroundTaskId: str(result.backgroundTaskId),
		timedOutAfterMs: num(result.timedOutAfterMs),
		persistedOutputPath: str(result.persistedOutputPath) ?? str(result.rawOutputPath),
		truncated: stdout.truncated || stderr.truncated,
	}
}

function readTodoItems(value: unknown): TodoItem[] {
	if (!Array.isArray(value)) return []
	const items: TodoItem[] = []
	for (const entry of value) {
		const todo = asRecord(entry)
		const content = str(todo?.content)
		if (!content) continue
		const status = todo?.status
		items.push({
			content,
			status:
				status === 'completed' || status === 'in_progress' || status === 'pending'
					? status
					: 'pending',
			activeForm: str(todo?.activeForm),
		})
	}
	return items
}

function todoDetails(
	result: Record<string, unknown>,
	args: Record<string, unknown> | null,
): TodoDetails | null {
	// `newTodos` is the post-update list. Fall back to the call's own arguments, which carry
	// the same list, so a CLI that omits the output field still renders.
	const all = readTodoItems(result.newTodos ?? args?.todos)
	if (all.length === 0) return null

	const items = all.slice(0, MAX_TODO_ITEMS)
	return {
		kind: 'todo',
		items,
		completed: items.filter((item) => item.status === 'completed').length,
		total: items.length,
		truncated: all.length > items.length,
	}
}

function readSubagentUsage(value: unknown): SubagentUsage | null {
	const usage = asRecord(value)
	if (!usage) return null
	const input = num(usage.input_tokens)
	const output = num(usage.output_tokens)
	if (input === null && output === null) return null
	return {
		inputTokens: Math.max(0, input ?? 0),
		outputTokens: Math.max(0, output ?? 0),
		cacheCreationTokens: Math.max(0, num(usage.cache_creation_input_tokens) ?? 0),
		cacheReadTokens: Math.max(0, num(usage.cache_read_input_tokens) ?? 0),
	}
}

function subagentDetails(toolName: string, result: Record<string, unknown>): SubagentDetails | null {
	const status = result.status
	if (status !== 'completed' && status !== 'async_launched' && status !== 'remote_launched') return null

	let report = ''
	let reportTruncated = false
	if (status === 'completed' && Array.isArray(result.content)) {
		const text = result.content
			.map((part) => {
				const block = asRecord(part)
				return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
			})
			.filter((part) => part.length > 0)
			.join('\n\n')
		reportTruncated = text.length > MAX_REPORT_CHARS
		report = reportTruncated ? text.slice(0, MAX_REPORT_CHARS) : text
	}

	return {
		kind: 'subagent',
		tool: toolName,
		status,
		sdkAgentId: str(result.agentId) ?? str(result.taskId),
		agentType: str(result.agentType),
		report,
		reportTruncated,
		totalTokens: num(result.totalTokens),
		totalToolUseCount: num(result.totalToolUseCount),
		totalDurationMs: num(result.totalDurationMs),
		usage: status === 'completed' ? readSubagentUsage(result.usage) : null,
		resolvedModel: str(result.resolvedModel),
	}
}

/**
 * Distil one tool call's structured output, or return null to fall back to the generic card.
 *
 * `toolUseResult` is `SDKUserMessage.tool_use_result`; `toolArguments` is the matching
 * `tool_use` block's input, which carries things the output leaves out (the command string,
 * the path on a tool that echoes neither).
 */
export function toolResultDetails(
	toolName: string,
	toolUseResult: unknown,
	toolArguments?: unknown,
): ToolResultDetails | null {
	if (!hasToolResultDetails(toolName)) return null
	const result = asRecord(toolUseResult)
	const args = asRecord(toolArguments)

	try {
		if (FILE_EDIT_TOOLS.has(toolName) || FILE_WRITE_TOOLS.has(toolName)) {
			return result ? fileEditDetails(toolName, result, args) : null
		}
		if (SHELL_TOOLS.has(toolName)) {
			return result ? shellDetails(toolName, result, args) : null
		}
		if (toolName === 'TodoWrite') {
			return todoDetails(result ?? {}, args)
		}
		if (SUBAGENT_TOOLS.has(toolName)) {
			return result ? subagentDetails(toolName, result) : null
		}
	} catch {
		// Never let a shape surprise kill the turn — the generic card is always a valid answer.
		return null
	}

	return null
}
