/**
 * Export one conversation (#18): a readable Markdown transcript, and a JSON document with
 * everything — every block, every tool call's full arguments and output.
 *
 * The two answer different needs. Markdown is for reading, pasting into a note or an issue,
 * or handing to another model, so long tool output is cut short there with a pointer to the
 * JSON. JSON is the archive: nothing is shortened, and it can be read back by a program.
 *
 * The transcript is the database's copy (`messages` and their `metadata.blocks`), which is
 * what the chat page renders — not the Agent SDK's session file.
 *
 * Pure and dependency-free, so specs can call it in the plain Playwright loader.
 */

import type { ToolResultDetails } from '../engine/tool-result-details'

export const EXPORT_FORMAT = 'agentstudio.conversation'
export const EXPORT_VERSION = 1

/** Markdown caps. The JSON export has none. */
const MD_SHELL_OUTPUT_CHARS = 4_000
const MD_ARGUMENTS_CHARS = 1_000
const MD_RESULT_CHARS = 2_000
const MD_SYSTEM_NOTE_CHARS = 300
const TRUNCATED_NOTE = '(truncated — see the JSON export for the full output)'

export type ExportConversation = {
	id: string
	title: string
	category: string | null
	model: string
	agentId: string | null
	projectId: string | null
	permissionMode: string
	totalTokens: number
	totalCost: string
	pinnedAt: Date | null
	archivedAt: Date | null
	createdAt: Date
	updatedAt: Date
}

export type ExportAttachment = { id?: string; filename: string; mimeType: string; size: number; url?: string }

export type ExportMessage = {
	id: string
	sequence: number
	role: string
	content: string
	model: string | null
	parentMessageId: string | null
	createdAt: Date
	tokensIn: number
	tokensOut: number
	cost: string
	attachments: ExportAttachment[]
	metadata: Record<string, unknown>
	toolCalls: Array<Record<string, unknown>>
}

export type ExportInput = {
	conversation: ExportConversation
	agent: { id: string; name: string } | null
	messages: ExportMessage[]
	exportedAt?: Date
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : ''
}

/** `2026-09-23 14:02 UTC` — UTC so the same export reads the same wherever it is opened. */
export function formatExportTime(value: Date | string): string {
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return ''
	return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * A code fence that the content cannot close: one backtick longer than the longest run of
 * backticks inside it, and never shorter than three. Tool output is arbitrary text — a file
 * with a Markdown code block in it would otherwise end the fence early and turn the rest of
 * the transcript into garbage.
 */
export function codeFence(content: string, language = ''): string {
	let longest = 0
	for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
	const fence = '`'.repeat(Math.max(3, longest + 1))
	return `${fence}${language}\n${content.replace(/\n$/, '')}\n${fence}`
}

/** Inline code the same way: enough backticks, padded when the content touches one. */
function inlineCode(content: string): string {
	const oneLine = content.replace(/\s*\n\s*/g, ' ')
	let longest = 0
	for (const match of oneLine.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
	const ticks = '`'.repeat(longest + 1)
	const pad = oneLine.startsWith('`') || oneLine.endsWith('`') ? ' ' : ''
	return `${ticks}${pad}${oneLine}${pad}${ticks}`
}

function capped(text: string, max: number): { text: string; truncated: boolean } {
	return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false }
}

/** The tail, for command output — a failing command explains itself at the end. */
function cappedTail(text: string, max: number): { text: string; truncated: boolean } {
	return text.length > max ? { text: text.slice(-max), truncated: true } : { text, truncated: false }
}

function formatBytes(size: number): string {
	if (!Number.isFinite(size) || size < 0) return ''
	if (size < 1024) return `${size} B`
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
	return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatCost(value: string | number): string {
	const n = typeof value === 'number' ? value : Number.parseFloat(value)
	if (!Number.isFinite(n)) return '$0'
	return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}

function stringifyJson(value: unknown): string {
	if (typeof value === 'string') {
		try {
			return JSON.stringify(JSON.parse(value), null, 2)
		} catch {
			return value
		}
	}
	try {
		return JSON.stringify(value, null, 2) ?? ''
	} catch {
		return String(value)
	}
}

function quote(text: string): string {
	return text
		.split('\n')
		.map((line) => (line ? `> ${line}` : '>'))
		.join('\n')
}

function diffFromHunks(details: Extract<ToolResultDetails, { kind: 'file_edit' }>): string {
	const lines: string[] = []
	for (const hunk of asArray(details.hunks)) {
		const h = asRecord(hunk)
		if (!h) continue
		lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
		for (const line of asArray(h.lines)) if (typeof line === 'string') lines.push(line)
	}
	return lines.join('\n')
}

function toolMarkdown(block: Record<string, unknown>): string {
	const name = str(block.name) || 'tool'
	const success = block.success === true || block.status === 'completed'
	const failed = block.success === false || block.status === 'failed' || block.status === 'denied'
	const mark = success ? ' ✓' : failed ? ' ✗' : ''
	const details = asRecord(block.details) as ToolResultDetails | null
	const out: string[] = []

	if (details?.kind === 'file_edit') {
		const counts = `(+${details.additions ?? 0} −${details.deletions ?? 0})`
		out.push(`**Tool · ${name}** ${inlineCode(str(details.path))} ${counts}${mark}`)
		const diff = diffFromHunks(details)
		if (diff) out.push(codeFence(diff, 'diff'))
		if (details.truncated) out.push(`_${TRUNCATED_NOTE}_`)
		return out.join('\n\n')
	}

	if (details?.kind === 'shell') {
		const description = details.description ? ` — ${details.description}` : ''
		out.push(`**Tool · ${name}**${mark}${description}`)
		if (details.command) out.push(codeFence(`$ ${details.command}`, 'sh'))
		const stdout = cappedTail(str(details.stdout), MD_SHELL_OUTPUT_CHARS)
		const stderr = cappedTail(str(details.stderr), MD_SHELL_OUTPUT_CHARS)
		if (stdout.text.trim()) out.push(codeFence(stdout.text, 'text'))
		if (stderr.text.trim()) out.push(`stderr:\n\n${codeFence(stderr.text, 'text')}`)
		if (stdout.truncated || stderr.truncated || details.truncated) out.push(`_${TRUNCATED_NOTE}_`)
		return out.join('\n\n')
	}

	if (details?.kind === 'todo') {
		out.push(`**Tool · ${name}**${mark}`)
		const items = asArray(details.items)
			.map((item) => asRecord(item))
			.filter((item): item is Record<string, unknown> => item !== null)
			.map((item) => `- [${item.status === 'completed' ? 'x' : ' '}] ${str(item.content)}`)
		if (items.length > 0) out.push(items.join('\n'))
		return out.join('\n\n')
	}

	out.push(`**Tool · ${name}**${mark}`)
	const args = block.arguments
	const argsText = args === undefined || args === null || args === '' ? '' : stringifyJson(args)
	if (argsText && argsText !== '{}') {
		const a = capped(argsText, MD_ARGUMENTS_CHARS)
		out.push(codeFence(a.text, 'json'))
		if (a.truncated) out.push(`_${TRUNCATED_NOTE}_`)
	}
	const resultText = typeof block.result === 'string' ? block.result : block.result == null ? '' : stringifyJson(block.result)
	if (resultText.trim()) {
		const r = capped(resultText, MD_RESULT_CHARS)
		out.push(`Result:\n\n${codeFence(r.text, 'text')}`)
		if (r.truncated) out.push(`_${TRUNCATED_NOTE}_`)
	}
	return out.join('\n\n')
}

/**
 * A delegated child's card, as a quote: who it was and what it was asked, the tools it called
 * with what each touched, what it said (or its final report, when it said nothing on the way),
 * and why it did not finish when it did not.
 *
 * Since #32 the card is the delegation's only record (there is no `tool` block beside it),
 * its calls are on `transcript`, and a child the user stopped is `stopped` rather than
 * failed. A card persisted before #32 has only `content` and `success`, and reads as before.
 */
function subagentMarkdown(block: Record<string, unknown>): string {
	const stopped = block.status === 'stopped'
	const failed = !stopped && (block.success === false || block.status === 'failed')
	const status = stopped ? ' (stopped)' : failed ? ' ✗' : ''
	const task = str(block.task).trim()
	const head = `**Subagent · ${str(block.agentName) || 'subagent'}**${status}${task ? ` — ${task.replace(/\s*\n\s*/g, ' ')}` : ''}`

	const calls = asArray(block.transcript)
		.map((entry) => asRecord(entry))
		.filter((call): call is Record<string, unknown> => call?.kind === 'tool' && str(call.name).trim() !== '')
		.map((call) => {
			const label = str(call.label).trim()
			return `- ${str(call.name).trim()}${label ? ` ${inlineCode(label)}` : ''}${call.success === false ? ' ✗' : ''}`
		})

	const said = str(block.content).trim()
	const body = said || str(asRecord(block.details)?.report).trim()
	const error = stopped || failed ? str(block.error).trim() : ''

	const parts = [head]
	if (calls.length > 0) parts.push(calls.join('\n'))
	if (body) parts.push(body)
	if (error) parts.push(`_${error.replace(/\s*\n\s*/g, ' ')}_`)
	return quote(parts.join('\n\n'))
}

function blockMarkdown(block: Record<string, unknown>): string {
	switch (block.kind) {
		case 'text':
			return str(block.content).trim()
		case 'thinking': {
			const content = str(block.content).trim()
			return content ? `<details><summary>Thinking</summary>\n\n${content}\n\n</details>` : ''
		}
		case 'subagent':
			return subagentMarkdown(block)
		case 'notice': {
			const notice = asRecord(block.notice)
			const title = str(notice?.title).trim()
			const detail = str(notice?.detail).trim()
			return title ? `_${title}${detail ? ` — ${detail}` : ''}_` : ''
		}
		case 'tool':
			return toolMarkdown(block)
		default:
			return typeof block.name === 'string' ? toolMarkdown(block) : ''
	}
}

function messageHeading(message: ExportMessage): string {
	const when = formatExportTime(message.createdAt)
	if (message.role === 'user') return `## You · ${when}`
	if (message.role === 'assistant') return `## Assistant${message.model ? ` (${message.model})` : ''} · ${when}`
	if (message.role === 'tool') return `## Tool · ${when}`
	return `## System · ${when}`
}

function systemNote(message: ExportMessage): string {
	const metadata = asRecord(message.metadata)
	if (metadata?.type === 'agent_anchor') return '_The conversation switched agents here._'
	const note = capped(message.content.trim(), MD_SYSTEM_NOTE_CHARS)
	return note.text ? quote(`_${note.text.replace(/\n+/g, ' ')}${note.truncated ? '…' : ''}_`) : ''
}

function messageMarkdown(message: ExportMessage): string {
	if (message.role === 'system') {
		const note = systemNote(message)
		return note ? `## System · ${formatExportTime(message.createdAt)}\n\n${note}` : ''
	}

	const parts: string[] = [messageHeading(message)]
	const metadata = asRecord(message.metadata) ?? {}
	const blocks = asArray(metadata.blocks).map(asRecord).filter((b): b is Record<string, unknown> => b !== null)
	const legacyTools = blocks.length === 0 ? asArray(message.toolCalls).map(asRecord).filter((b): b is Record<string, unknown> => b !== null) : []

	const hasText = blocks.some((block) => block.kind === 'text' && str(block.content).trim())
	if (!hasText && message.content.trim()) parts.push(message.content.trim())
	for (const block of [...blocks, ...legacyTools]) {
		const rendered = blockMarkdown(block)
		if (rendered) parts.push(rendered)
	}

	const attachments = asArray(message.attachments)
		.map(asRecord)
		.filter((a): a is Record<string, unknown> => a !== null && typeof a.filename === 'string')
	if (attachments.length > 0) {
		parts.push(
			`**Attachments:**\n\n${attachments
				.map((a) => {
					const size = typeof a.size === 'number' ? formatBytes(a.size) : ''
					const info = [str(a.mimeType), size].filter(Boolean).join(', ')
					return `- ${inlineCode(str(a.filename))}${info ? ` (${info})` : ''}`
				})
				.join('\n')}`,
		)
	}
	if (metadata.stoppedByUser === true) parts.push('_Stopped by the user._')
	return parts.join('\n\n')
}

/** A readable transcript. Long tool output is shortened; the JSON export has all of it. */
export function exportConversationMarkdown(input: ExportInput): string {
	const { conversation, agent, messages } = input
	const exportedAt = input.exportedAt ?? new Date()
	const status = [conversation.pinnedAt ? 'Pinned' : '', conversation.archivedAt ? 'Archived' : ''].filter(Boolean)
	const header = [
		`# ${conversation.title.replace(/\s*\n\s*/g, ' ').trim() || 'Untitled conversation'}`,
		'',
		`- Exported: ${formatExportTime(exportedAt)}`,
		`- Started: ${formatExportTime(conversation.createdAt)}`,
		`- Last activity: ${formatExportTime(conversation.updatedAt)}`,
		...(agent ? [`- Agent: ${agent.name}`] : []),
		`- Model: ${conversation.model}`,
		`- Tokens: ${conversation.totalTokens.toLocaleString('en-US')} · Cost: ${formatCost(conversation.totalCost)}`,
		`- Messages: ${messages.length}`,
		...(status.length > 0 ? [`- Status: ${status.join(', ')}`] : []),
	].join('\n')

	const body = messages.map(messageMarkdown).filter(Boolean)
	return `${[header, ...body].join('\n\n---\n\n')}\n`
}

/** Everything, unshortened. The owner's id is left out; nothing else is. */
export function exportConversationJson(input: ExportInput) {
	const { conversation, agent, messages } = input
	return {
		format: EXPORT_FORMAT,
		version: EXPORT_VERSION,
		exportedAt: (input.exportedAt ?? new Date()).toISOString(),
		conversation: {
			id: conversation.id,
			title: conversation.title,
			category: conversation.category,
			model: conversation.model,
			agent: agent ? { id: agent.id, name: agent.name } : null,
			projectId: conversation.projectId,
			permissionMode: conversation.permissionMode,
			totalTokens: conversation.totalTokens,
			totalCost: conversation.totalCost,
			pinnedAt: conversation.pinnedAt ? new Date(conversation.pinnedAt).toISOString() : null,
			archivedAt: conversation.archivedAt ? new Date(conversation.archivedAt).toISOString() : null,
			createdAt: new Date(conversation.createdAt).toISOString(),
			updatedAt: new Date(conversation.updatedAt).toISOString(),
		},
		messages: messages.map((message) => ({
			id: message.id,
			sequence: message.sequence,
			role: message.role,
			content: message.content,
			model: message.model,
			parentMessageId: message.parentMessageId,
			createdAt: new Date(message.createdAt).toISOString(),
			tokensIn: message.tokensIn,
			tokensOut: message.tokensOut,
			cost: message.cost,
			attachments: message.attachments,
			toolCalls: message.toolCalls,
			metadata: message.metadata,
		})),
	}
}

/**
 * Download file names for an export: an ASCII one for `filename=` and the readable one for
 * `filename*=` (RFC 6266), both `<title>-<yyyy-mm-dd>.<ext>`.
 */
export function exportFileNames(title: string, date: Date, extension: 'md' | 'json'): { ascii: string; utf8: string } {
	const day = new Date(date).toISOString().slice(0, 10)
	const slug =
		title
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60)
			.replace(/-+$/g, '') || 'conversation'
	const readable =
		firstCodePoints(
			title
				.replace(LONE_SURROGATE, '')
				.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
				.replace(/\s+/g, ' ')
				.trim(),
			80,
		).trim() || 'conversation'
	return { ascii: `${slug}-${day}.${extension}`, utf8: `${readable}-${day}.${extension}` }
}

/** Half of a surrogate pair with no other half: not valid Unicode, and `encodeURIComponent` throws on it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * The first `max` characters of `text`, counted in code points. `slice` counts UTF-16 units,
 * so cutting there can split an emoji into a lone surrogate.
 */
function firstCodePoints(text: string, max: number): string {
	return Array.from(text).slice(0, max).join('')
}

/** The `Content-Disposition` header value for an export download. */
export function exportContentDisposition(names: { ascii: string; utf8: string }): string {
	const encoded = encodeURIComponent(names.utf8).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
	return `attachment; filename="${names.ascii}"; filename*=UTF-8''${encoded}`
}
