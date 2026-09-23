import { expect, test } from '@playwright/test'
import {
	buildMessageSearchText,
	pathSearchTerms,
	SEARCH_TEXT_MAX_CHARS,
} from '../src/lib/chat/message-search-text'
import {
	normalizeSearchInput,
	searchQueryParts,
	SNIPPET_START,
	SNIPPET_STOP,
	splitSnippet,
} from '../src/lib/chat/conversation-search'

/**
 * #18 — what a message is found by in conversation search, and how a typed search becomes a
 * Postgres text query.
 *
 * Pure-function tests: both modules import nothing, so this runs without Postgres or a dev
 * server. The database half (the index, the ranking, the scoping) is
 * `chat.conversation-search.spec.ts`.
 *
 * The owner's headline case is "the run where it touched options.server.ts". Postgres reads
 * a path as one token, so without the segment expansion pinned here that search silently
 * finds nothing — which is exactly the failure a spec has to hold.
 */

function toolBlock(overrides: Record<string, unknown>) {
	return { kind: 'tool', arguments: {}, result: '', success: true, executionMs: 1, ...overrides }
}

test.describe('buildMessageSearchText — what is indexed', () => {
	test('an Edit is found by its full path, its file name and each segment of it', () => {
		const text = buildMessageSearchText({
			role: 'assistant',
			content: 'Done.',
			metadata: {
				blocks: [
					toolBlock({
						name: 'Edit',
						arguments: { file_path: 'src/lib/engine/options.server.ts', old_string: 'a', new_string: 'b' },
						details: {
							kind: 'file_edit',
							tool: 'Edit',
							path: 'src/lib/engine/options.server.ts',
							changeType: 'update',
							hunks: [],
							additions: 1,
							deletions: 1,
							unavailable: 'none',
							truncated: false,
						},
					}),
				],
			},
		})
		expect(text).toContain('Edit:')
		expect(text).toContain('src/lib/engine/options.server.ts')
		expect(text).toContain(' options.server.ts ')
		expect(text).toContain('src lib engine options server ts')
		// The same path from `details` and from the arguments is spelled out once.
		expect(text.split('src/lib/engine/options.server.ts').length - 1).toBe(1)
	})

	test('a shell call is found by its command, its description and the links it printed', () => {
		const text = buildMessageSearchText({
			role: 'assistant',
			content: 'Opened it.',
			metadata: {
				blocks: [
					toolBlock({
						name: 'Bash',
						arguments: { command: 'gh pr create --title "Tidy the sidebar"', description: 'Open the pull request' },
						result: `${'Creating pull request…\n'.repeat(400)}https://github.com/derekhearst/AgentStudio/pull/93\n`,
					}),
				],
			},
		})
		expect(text).toContain('gh pr create --title "Tidy the sidebar"')
		expect(text).toContain('Open the pull request')
		expect(text).toContain('https://github.com/derekhearst/AgentStudio/pull/93')
		// The rest of the output is not indexed, only the link in it.
		expect(text).not.toContain('Creating pull request')
	})

	test('file bodies, edit payloads, thinking, notices and raw tool output are left out', () => {
		const text = buildMessageSearchText({
			role: 'assistant',
			content: 'Wrote the file.',
			metadata: {
				blocks: [
					{ kind: 'thinking', content: 'privatethoughtmarker' },
					{ kind: 'notice', notice: { kind: 'compacted', level: 'info', title: 'noticemarker', detail: null, persist: true } },
					toolBlock({ name: 'Write', arguments: { file_path: 'notes/plan.md', content: 'filebodymarker' } }),
					toolBlock({ name: 'Edit', arguments: { file_path: 'a.ts', old_string: 'oldmarker', new_string: 'newmarker' } }),
					toolBlock({ name: 'Read', arguments: { file_path: 'b.ts' }, result: 'rawresultmarker' }),
				],
			},
		})
		for (const marker of ['privatethoughtmarker', 'noticemarker', 'filebodymarker', 'oldmarker', 'newmarker', 'rawresultmarker']) {
			expect(text, marker).not.toContain(marker)
		}
		expect(text).toContain('notes/plan.md')
		expect(text).toContain('Read: b.ts')
	})

	test('short unknown arguments are kept, long ones are not', () => {
		const text = buildMessageSearchText({
			role: 'assistant',
			content: '',
			metadata: {
				blocks: [
					toolBlock({
						name: 'mcp__github__create_issue',
						arguments: { title: 'Sidebar search is slow', body: 'x'.repeat(301) },
					}),
				],
			},
		})
		expect(text).toContain('mcp__github__create_issue:')
		expect(text).toContain('Sidebar search is slow')
		expect(text).not.toContain('x'.repeat(301))
	})

	test('arguments stored as a JSON string, subagents, attachments and the older toolCalls are read', () => {
		const fromString = buildMessageSearchText({
			role: 'assistant',
			content: '',
			metadata: { blocks: [toolBlock({ name: 'Grep', arguments: JSON.stringify({ pattern: 'resolveParentMessage' }) })] },
		})
		expect(fromString).toContain('resolveParentMessage')

		const subagent = buildMessageSearchText({
			role: 'assistant',
			content: '',
			metadata: {
				blocks: [
					{ kind: 'subagent', agentId: 't1', agentName: 'Researcher', conversationId: null, task: 'compare pgvector indexes', content: 'HNSW wins', success: true },
				],
			},
		})
		expect(subagent).toContain('Subagent Researcher: compare pgvector indexes HNSW wins')

		const withAttachment = buildMessageSearchText({
			role: 'user',
			content: 'See the screenshot',
			attachments: [{ id: '1', filename: 'login-error.png', mimeType: 'image/png', size: 10, url: '/x' }],
		})
		expect(withAttachment).toContain('login-error.png')
		expect(withAttachment).toContain('login error png')

		const legacy = buildMessageSearchText({
			role: 'assistant',
			content: 'old turn',
			toolCalls: [{ name: 'read_file', arguments: { path: 'docs/legacy/notes.md' }, result: 'x', status: 'completed' }],
		})
		expect(legacy).toContain('read_file: docs/legacy/notes.md')
	})

	test('paths mentioned in prose get the same segment expansion', () => {
		const text = buildMessageSearchText({ role: 'assistant', content: 'I changed conversation-list.server.ts.' })
		expect(text).toContain('conversation list server ts')
	})

	test('a system message indexes as nothing', () => {
		expect(buildMessageSearchText({ role: 'system', content: '[Agent changed to Plan] You are now acting as Plan.' })).toBe('')
	})

	test('the snippet markers cannot be forged by a message', () => {
		const text = buildMessageSearchText({ role: 'user', content: `a${SNIPPET_START}fake${SNIPPET_STOP}b` })
		expect(text).not.toContain(SNIPPET_START)
		expect(text).not.toContain(SNIPPET_STOP)
	})

	test('the text is capped however large the message is', () => {
		const huge = 'word '.repeat(1_000_000) // 5MB
		const text = buildMessageSearchText({
			role: 'assistant',
			content: huge,
			metadata: {
				blocks: [
					toolBlock({ name: 'Read', arguments: { file_path: 'big.log' }, result: huge }),
					toolBlock({ name: 'Write', arguments: { file_path: 'big.txt', content: huge } }),
				],
			},
		})
		expect(text.length).toBeLessThanOrEqual(SEARCH_TEXT_MAX_CHARS)
		expect(text).toContain('Read: big.log')
	})

	test('pathSearchTerms', () => {
		expect(pathSearchTerms('src/lib/engine/options.server.ts')).toBe(
			'src/lib/engine/options.server.ts options.server.ts src lib engine options server ts',
		)
		expect(pathSearchTerms('README')).toBe('README')
		expect(pathSearchTerms('  ')).toBe('')
	})
})

test.describe('searchQueryParts — how a search becomes a text query', () => {
	test('a path-shaped search also looks for its segments as a phrase', () => {
		expect(searchQueryParts('options.server.ts')).toEqual({
			exact: 'options.server.ts',
			segmented: '"options server ts"',
			prefix: null,
		})
		expect(searchQueryParts('engine/options.server.ts')).toEqual({
			exact: 'engine/options.server.ts',
			segmented: '"engine options server ts"',
			prefix: null,
		})
	})

	test('the last plain word matches as a prefix, so results appear while typing', () => {
		expect(searchQueryParts('deplo')).toEqual({ exact: null, segmented: null, prefix: 'deplo:*' })
		expect(searchQueryParts('fix the Sideb')).toEqual({ exact: 'fix the', segmented: null, prefix: 'sideb:*' })
	})

	test('no prefix inside an open quote, after an OR, for an operator or a single letter', () => {
		expect(searchQueryParts('"fix the side').prefix).toBeNull()
		expect(searchQueryParts('login or signup').prefix).toBeNull()
		expect(searchQueryParts('login or').prefix).toBeNull()
		expect(searchQueryParts('fix a').prefix).toBeNull()
		expect(searchQueryParts('fix a').exact).toBe('fix a')
	})

	test('a negated or quoted term is left as typed', () => {
		expect(searchQueryParts('-options.server.ts deploy').segmented).toBeNull()
		expect(searchQueryParts('"options.server.ts" deploy').segmented).toBeNull()
	})

	test('input is normalized, and empty input is empty', () => {
		expect(normalizeSearchInput('  a\t\u0002b \n c ')).toBe('a b c')
		expect(searchQueryParts('   ')).toEqual({ exact: null, segmented: null, prefix: null })
	})
})

test.describe('splitSnippet — highlights as text, never as HTML', () => {
	test('marked runs are split out and nothing is interpreted', () => {
		expect(splitSnippet(`the ${SNIPPET_START}<b>options</b>${SNIPPET_STOP} file`)).toEqual([
			{ text: 'the ', mark: false },
			{ text: '<b>options</b>', mark: true },
			{ text: ' file', mark: false },
		])
		expect(splitSnippet('plain')).toEqual([{ text: 'plain', mark: false }])
		expect(splitSnippet('')).toEqual([])
	})
})
