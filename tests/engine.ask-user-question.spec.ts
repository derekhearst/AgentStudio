import { expect, test } from '@playwright/test'
import type { HookCallbackMatcher, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import {
	ASK_USER_QUESTION_SETTINGS,
	ASK_USER_QUESTION_TOOL,
	ASK_USER_QUESTION_TOOL_CONFIG,
	ASK_USER_REFUSALS,
	EMPTY_SELECTION,
	MAX_PREVIEW_CHARS,
	PREVIEW_CSP,
	answerAskUserQuestion,
	answerKey,
	answersByQuestion,
	focusOther,
	isAskUserToolName,
	optionLabel,
	previewDocument,
	previewOption,
	readAskQuestions,
	selectionAnswer,
	selectionAnswers,
	toggleOption,
	writeOther,
	type AskQuestion,
	type AskUserHost,
} from '../src/lib/engine/ask-user-question'
import { toolResultDetails } from '../src/lib/engine/tool-result-details'
import { resolveToolScope, type ToolScope } from '../src/lib/engine/tool-scope'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * #4 — the SDK's native AskUserQuestion replaces AgentStudio's own `ask_user`.
 *
 * What was verified against the installed SDK (0.3.278) before any of this was built, and
 * what these tests therefore pin rather than assume:
 *
 *   - `Options.toolConfig.askUserQuestion.previewFormat` exists, and `askUserQuestionTimeout`
 *     is a field of `Settings` (not of `Options`), reached through `Options.settings`;
 *   - the tool's permission check always asks, so the call reaches `canUseTool`, and the host
 *     answers by allowing with `updatedInput.answers` — question text → answer, multi-select
 *     comma-separated — which the CLI's `call()` reads back and echoes as
 *     `tool_use_result.answers`;
 *   - "Other" is automatic: the model is told never to add one.
 *
 * The first blocks are pure. The last drives `runEngineStream` with a scripted SDK; it
 * needs a database only because the engine transitively imports the tool registry.
 */

const Q1: AskQuestion = {
	key: 'Which layout should the page use?',
	header: 'Layout',
	question: 'Which layout should the page use?',
	options: [
		{ label: 'Sidebar (Recommended)', description: 'Nav on the left', preview: '<div style="display:flex">side</div>', recommended: true },
		{ label: 'Top bar', description: 'Nav across the top', preview: '<div>top</div>' },
		{ label: 'None', description: 'No navigation' },
	],
	multiSelect: false,
	allowFreeformInput: true,
}

const Q2: AskQuestion = {
	key: 'Which features do you want?',
	header: 'Features',
	question: 'Which features do you want?',
	options: [
		{ label: 'Search', description: 'Full-text search' },
		{ label: 'Export', description: 'CSV export' },
		{ label: 'Share', description: 'Share links' },
	],
	multiSelect: true,
	allowFreeformInput: true,
}

test.describe('reading a call', () => {
	test('an AskUserQuestion input reads into keyed questions, previews and all', () => {
		const questions = readAskQuestions({
			questions: [
				{
					question: 'Which layout should the page use?',
					header: 'Layout',
					multiSelect: false,
					options: [
						{ label: 'Sidebar (Recommended)', description: 'Nav on the left', preview: '<div style="display:flex">side</div>' },
						{ label: 'Top bar', description: 'Nav across the top', preview: '<div>top</div>' },
						{ label: 'None', description: 'No navigation' },
					],
				},
			],
		})
		expect(questions).toEqual([Q1])
		// Stable: the normalised form (what the frame and the pending row carry) reads back the same.
		expect(readAskQuestions({ questions })).toEqual(questions)
		expect(answerKey(questions[0])).toBe(Q1.question)
	})

	test('"(Recommended)" is a badge, not part of the label shown — but the label sent back is verbatim', () => {
		expect(optionLabel('Sidebar (Recommended)')).toBe('Sidebar')
		expect(optionLabel('Sidebar (recommended) ')).toBe('Sidebar')
		expect(optionLabel('(Recommended)')).toBe('(Recommended)')
		const [q] = readAskQuestions({ questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }] })
		expect(q.options[0]).toMatchObject({ label: 'A (Recommended)', recommended: true })
		expect(q.options[1].recommended).toBeUndefined()
	})

	test('a runaway preview is dropped whole, not cut', () => {
		const [q] = readAskQuestions({
			questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A', preview: 'x'.repeat(MAX_PREVIEW_CHARS + 1) }, { label: 'B', preview: '<b>ok</b>' }] }],
		})
		expect(q.options[0].preview).toBeUndefined()
		expect(q.options[1].preview).toBe('<b>ok</b>')
	})

	test('a retired ask_user block reads the old way: keyed by header, no previews, Other can be off', () => {
		const [q] = readAskQuestions(
			{ questions: [{ header: 'Color', options: [{ label: 'green', preview: '<b>x</b>' }], allowFreeformInput: false }] },
			{ legacy: true },
		)
		expect(q).toEqual({ header: 'Color', question: 'Color', options: [{ label: 'green' }], allowFreeformInput: false })
		expect(answerKey(q)).toBe('Color')
	})

	test('junk is skipped, not thrown on', () => {
		expect(readAskQuestions(null)).toEqual([])
		expect(readAskQuestions({ questions: 'nope' })).toEqual([])
		expect(readAskQuestions({ questions: [null, 3, { header: 'no question' }, { question: 'Q?', options: [{}, { label: '' }] }] })).toEqual([
			{ key: 'Q?', header: '', question: 'Q?', options: [], multiSelect: false, allowFreeformInput: true },
		])
	})

	test('both names are question blocks', () => {
		expect(isAskUserToolName('AskUserQuestion')).toBe(true)
		expect(isAskUserToolName('ask_user')).toBe(true)
		expect(isAskUserToolName('Read')).toBe(false)
		expect(isAskUserToolName(undefined)).toBe(false)
	})
})

test.describe('what the user picked', () => {
	test('single-select: an option replaces the last one, and "Other" replaces the option', () => {
		let s = toggleOption(Q1, EMPTY_SELECTION, 'Top bar')
		s = toggleOption(Q1, s, 'Sidebar (Recommended)')
		expect(selectionAnswer(Q1, s)).toBe('Sidebar (Recommended)')

		s = focusOther(Q1, s)
		expect(s.selected).toEqual([])
		expect(selectionAnswer(Q1, s)).toBe('') // chose Other, typed nothing yet
		s = writeOther(Q1, s, '  A hamburger menu  ')
		expect(selectionAnswer(Q1, s)).toBe('A hamburger menu')

		// Clicking an option again takes it back from "Other"; the typed text is kept, unused.
		s = toggleOption(Q1, s, 'None')
		expect(selectionAnswer(Q1, s)).toBe('None')
		expect(s.other).toBe('  A hamburger menu  ')
	})

	test('multi-select: options toggle, "Other" is added, and the answer is comma-separated in option order', () => {
		let s = toggleOption(Q2, EMPTY_SELECTION, 'Share')
		s = toggleOption(Q2, s, 'Search')
		s = toggleOption(Q2, s, 'Export')
		s = toggleOption(Q2, s, 'Export')
		expect(focusOther(Q2, s)).toBe(s)
		s = writeOther(Q2, s, 'Dark mode')
		expect(selectionAnswer(Q2, s)).toBe('Search, Share, Dark mode')
		s = writeOther(Q2, s, '   ')
		expect(selectionAnswer(Q2, s)).toBe('Search, Share')
	})

	test('the card submits only answered questions, keyed by question text', () => {
		const selections = { [answerKey(Q2)]: toggleOption(Q2, EMPTY_SELECTION, 'Export') }
		expect(selectionAnswers([Q1, Q2], selections)).toEqual({ 'Which features do you want?': 'Export' })
	})

	test('the preview shown: focused, else chosen, else recommended, else the first with one', () => {
		expect(previewOption(Q1, EMPTY_SELECTION, null)?.label).toBe('Sidebar (Recommended)')
		expect(previewOption(Q1, toggleOption(Q1, EMPTY_SELECTION, 'Top bar'), null)?.label).toBe('Top bar')
		expect(previewOption(Q1, toggleOption(Q1, EMPTY_SELECTION, 'Top bar'), 'Sidebar (Recommended)')?.label).toBe('Sidebar (Recommended)')
		// An option with no preview never blanks the pane.
		expect(previewOption(Q1, toggleOption(Q1, EMPTY_SELECTION, 'None'), 'None')?.label).toBe('Sidebar (Recommended)')
		expect(previewOption(Q2, EMPTY_SELECTION, null)).toBeNull()
	})
})

test.describe('answering the SDK', () => {
	const input = { questions: [{ question: Q1.question, header: 'Layout', multiSelect: false, options: Q1.options }] }
	const signal = () => new AbortController().signal

	test('answers go back as updatedInput.answers, keyed by question text, the rest of the input untouched', async () => {
		const seen: string[] = []
		const host: AskUserHost = async ({ toolUseId, questions }) => {
			seen.push(toolUseId)
			expect(questions.map((q) => q.key)).toEqual([Q1.question])
			return { answers: { [Q1.question]: ' Top bar ' } }
		}
		const outcome = await answerAskUserQuestion({ toolUseId: 'toolu_1', input, signal: signal(), fromSubagent: false, host })
		expect(seen).toEqual(['toolu_1'])
		expect(outcome.answers).toEqual({ [Q1.question]: 'Top bar' })
		expect(outcome.permission).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { [Q1.question]: 'Top bar' } } })
	})

	test('an answer keyed by header (the composer shortcut) or with stray whitespace still lands', () => {
		expect(answersByQuestion([Q1], { Layout: 'None' })).toEqual({ [Q1.question]: 'None' })
		expect(answersByQuestion([Q1], { [` ${Q1.question} `]: 'None' })).toEqual({ [Q1.question]: 'None' })
		expect(answersByQuestion([Q1, Q2], { [Q1.question]: '  ' })).toEqual({})
	})

	test('nobody to ask: refused at once, never left waiting', async () => {
		const outcome = await answerAskUserQuestion({ toolUseId: 't', input, signal: signal(), fromSubagent: false, host: null })
		expect(outcome.permission).toEqual({ behavior: 'deny', message: ASK_USER_REFUSALS.noHost })
		expect(outcome.answers).toBeNull()
	})

	test("a subagent's question is refused, and the host is never asked", async () => {
		let asked = false
		const outcome = await answerAskUserQuestion({
			toolUseId: 't',
			input,
			signal: signal(),
			fromSubagent: true,
			host: async () => {
				asked = true
				return { answers: {} }
			},
		})
		expect(asked).toBe(false)
		expect(outcome.permission).toEqual({ behavior: 'deny', message: ASK_USER_REFUSALS.subagent })
	})

	test('a malformed call, an unanswered one and a failed host each come back as a reason', async () => {
		const host: AskUserHost = async () => ({ answers: null })
		expect((await answerAskUserQuestion({ toolUseId: 't', input: { questions: [] }, signal: signal(), fromSubagent: false, host })).permission).toEqual({
			behavior: 'deny',
			message: ASK_USER_REFUSALS.malformed,
		})
		expect((await answerAskUserQuestion({ toolUseId: 't', input, signal: signal(), fromSubagent: false, host })).permission).toEqual({
			behavior: 'deny',
			message: ASK_USER_REFUSALS.unanswered,
		})
		const broken: AskUserHost = async () => {
			throw new Error('db down')
		}
		expect((await answerAskUserQuestion({ toolUseId: 't', input, signal: signal(), fromSubagent: false, host: broken })).permission).toEqual({
			behavior: 'deny',
			message: ASK_USER_REFUSALS.failed,
		})
	})

	test('a stop while the question waits settles it, whatever the host is doing', async () => {
		const controller = new AbortController()
		const never: AskUserHost = () => new Promise(() => {})
		const pending = answerAskUserQuestion({ toolUseId: 't', input, signal: controller.signal, fromSubagent: false, host: never })
		setTimeout(() => controller.abort(), 10)
		expect((await pending).permission).toEqual({ behavior: 'deny', message: ASK_USER_REFUSALS.aborted })

		// Already stopped: the host is not even called.
		let asked = false
		const outcome = await answerAskUserQuestion({
			toolUseId: 't',
			input,
			signal: AbortSignal.abort(),
			fromSubagent: false,
			host: async () => {
				asked = true
				return { answers: null }
			},
		})
		expect(asked).toBe(false)
		expect(outcome.permission).toEqual({ behavior: 'deny', message: ASK_USER_REFUSALS.aborted })
	})

	test("the answers read back off the CLI's tool_use_result, a list joined the way the SDK documents", () => {
		expect(toolResultDetails('AskUserQuestion', { questions: [], answers: { 'Q?': 'A' } })).toEqual({
			kind: 'ask_user_question',
			answers: { 'Q?': 'A' },
		})
		expect(toolResultDetails('AskUserQuestion', { answers: { 'Q?': ['A', 'B'] } })).toEqual({
			kind: 'ask_user_question',
			answers: { 'Q?': 'A, B' },
		})
		expect(toolResultDetails('AskUserQuestion', { answers: {} })).toBeNull()
		expect(toolResultDetails('AskUserQuestion', 'error text')).toBeNull()
	})
})

test.describe('previews', () => {
	test('the document forbids every load and carries the fragment inert', () => {
		const doc = previewDocument(
			'<p style="color:red">hi</p><img src="https://evil.example/px.gif"><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://evil.example"><iframe src="/"></iframe><form action="/x"></form><base href="https://evil.example/">',
		)
		expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`)
		expect(PREVIEW_CSP).toContain("default-src 'none'")
		expect(PREVIEW_CSP).not.toMatch(/script-src|https?:/)
		// Inline styles survive — they are the point of a preview.
		expect(doc).toContain('<p style="color:red">hi</p>')
		const body = doc.slice(doc.indexOf('<body>'))
		for (const tag of ['<script', '<meta', '<iframe', '<form', '<base']) expect(body, tag).not.toContain(tag)
		expect(body).toContain('&lt;script')
	})

	test('the card renders it in a frame with no permissions at all', () => {
		// No `allow-scripts`, no `allow-same-origin`: an opaque origin with scripts off, so a
		// preview can neither run code nor reach the app, its cookies or its remote functions.
		const source = readFileSync(resolve('src/lib/chat/AskUserPreview.svelte'), 'utf8')
		expect(source).toMatch(/<iframe[\s\S]*?sandbox=""[\s\S]*?\{srcdoc\}/)
		expect(source).not.toMatch(/allow-scripts|allow-same-origin|\{@html/)
	})
})

test.describe('what buildEngineOptions hands the SDK', () => {
	test('HTML previews, and a question that never answers itself', () => {
		expect(ASK_USER_QUESTION_TOOL_CONFIG).toEqual({ askUserQuestion: { previewFormat: 'html' } })
		expect(ASK_USER_QUESTION_SETTINGS).toEqual({ askUserQuestionTimeout: 'never' })
		// Read as source: `options.server.ts` imports `$env`, which this runtime cannot resolve.
		const source = readFileSync(resolve('src/lib/engine/options.server.ts'), 'utf8')
		expect(source).toMatch(/toolConfig:\s*ASK_USER_QUESTION_TOOL_CONFIG/)
		expect(source).toMatch(/settings:\s*ASK_USER_QUESTION_SETTINGS/)
	})
})

// ── Driven through the engine ────────────────────────────────────────────────────────────

type Frame = { event: string; payload: Record<string, unknown> }
type Call = { id: string; input: Record<string, unknown>; parent?: string | null }

const WS = process.platform === 'win32' ? 'C:\\sandbox\\u1\\runs\\r1' : '/sandbox/u1/runs/r1'

/**
 * A scripted SDK for question calls: announce the call, run the CLI's permission pipeline
 * (the PreToolUse hook, then `canUseTool` — AskUserQuestion's own check always asks), then
 * yield the result the CLI would: on an allow, the text the model reads plus the
 * `tool_use_result` echoing the answers it was given.
 */
async function driveQuestions(
	input: { askUser?: AskUserHost; requiresApproval?: () => boolean; toolScope?: ToolScope | null },
	calls: Call[],
) {
	const { runEngineStream } = await import('../src/lib/engine/stream.server')
	const frames: Frame[] = []
	const permissions: PermissionResult[] = []
	const hooks: string[] = []
	const summary = await runEngineStream({
		prompt: 'go',
		options: {},
		workspaceRoot: WS,
		bashPolicy: 'sandboxed',
		requiresApproval: input.requiresApproval ?? (() => false),
		...(input.askUser ? { askUser: input.askUser } : {}),
		...(input.toolScope ? { toolScope: input.toolScope } : {}),
		createQuery: ({ options }: { options: Options }) => ({
			async *[Symbol.asyncIterator]() {
				for (const call of calls) {
					const parent = call.parent ?? null
					yield {
						type: 'assistant',
						parent_tool_use_id: parent,
						message: { content: [{ type: 'tool_use', id: call.id, name: ASK_USER_QUESTION_TOOL, input: call.input }] },
					} as never
					let hook = 'none'
					for (const matcher of (options.hooks?.PreToolUse ?? []) as HookCallbackMatcher[]) {
						for (const fn of matcher.hooks) {
							const out = (await fn(
								{ hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '', cwd: WS, tool_name: ASK_USER_QUESTION_TOOL, tool_input: call.input, tool_use_id: call.id } as never,
								call.id,
								{ signal: new AbortController().signal },
							)) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
							hook = out.hookSpecificOutput?.permissionDecision ?? hook
						}
					}
					hooks.push(hook)
					const permission: PermissionResult =
						hook === 'deny'
							? { behavior: 'deny', message: 'refused by the hook' }
							: ((await options.canUseTool!(ASK_USER_QUESTION_TOOL, call.input, {
									signal: new AbortController().signal,
									toolUseID: call.id,
									requestId: 'r',
									...(parent ? { agentID: 'agent-1' } : {}),
								})) as PermissionResult)
					permissions.push(permission)
					const answers = permission.behavior === 'allow' ? (permission.updatedInput?.answers as Record<string, string>) : null
					yield {
						type: 'user',
						parent_tool_use_id: parent,
						message: {
							content: [
								{
									type: 'tool_result',
									tool_use_id: call.id,
									content: answers
										? `User has answered your questions: ${Object.entries(answers).map(([q, a]) => `"${q}"="${a}"`).join(', ')}.`
										: permission.behavior === 'deny' ? permission.message : '',
									is_error: !answers,
								},
							],
						},
						...(answers ? { tool_use_result: { questions: call.input.questions, answers } } : {}),
					} as never
				}
				yield { type: 'result', usage: {}, duration_ms: 1, num_turns: 1 } as never
			},
		}),
		emit: async (event: string, payload: unknown) => {
			frames.push({ event, payload: (payload ?? {}) as Record<string, unknown> })
		},
	})
	return { frames, permissions, hooks, summary }
}

test.describe('the engine hands AskUserQuestion to the host', () => {
	const call = { id: 'toolu_ask1', input: { questions: [{ question: Q2.question, header: 'Features', multiSelect: true, options: Q2.options }] } }

	test('answered: allowed with the answers, no approval card, and a saved block that shows them after a reload', async () => {
		const { frames, permissions, summary } = await driveQuestions(
			{
				// Every approval setting on: none of them reaches a question.
				requiresApproval: () => true,
				askUser: async () => ({ answers: { [Q2.question]: 'Search, Export' } }),
			},
			[call],
		)
		expect(permissions[0]).toEqual({ behavior: 'allow', updatedInput: { ...call.input, answers: { [Q2.question]: 'Search, Export' } } })
		const own = frames.filter((f) => f.payload.id === call.id).map((f) => f.event)
		expect(own).toEqual(['tool_result'])
		const result = frames.find((f) => f.event === 'tool_result')!
		expect(result.payload).toMatchObject({ name: 'AskUserQuestion', success: true, details: { kind: 'ask_user_question', answers: { [Q2.question]: 'Search, Export' } } })
		expect(summary.blocks).toContainEqual(
			expect.objectContaining({
				kind: 'tool',
				name: 'AskUserQuestion',
				arguments: call.input,
				success: true,
				details: { kind: 'ask_user_question', answers: { [Q2.question]: 'Search, Export' } },
			}),
		)
	})

	test('no host (a run nobody can answer): refused with a reason the model can act on', async () => {
		const { permissions, frames } = await driveQuestions({}, [call])
		expect(permissions[0]).toEqual({ behavior: 'deny', message: ASK_USER_REFUSALS.noHost })
		expect(frames.find((f) => f.event === 'tool_result')?.payload).toMatchObject({ success: false })
	})

	test('an agent scoped without it is refused in the hook at once, and nobody is asked', async () => {
		let asked = 0
		const started = Date.now()
		const { hooks, permissions } = await driveQuestions(
			{
				toolScope: resolveToolScope(['Read'], { delegation: false }),
				askUser: async () => {
					asked += 1
					return { answers: {} }
				},
			},
			[call],
		)
		expect(hooks).toEqual(['deny'])
		expect(permissions[0].behavior).toBe('deny')
		expect(asked).toBe(0)
		// The call was announced, so the refusal does not sit out the announcement wait.
		expect(Date.now() - started).toBeLessThan(1_500)
	})

	test('an old agent listing ask_user keeps the ability to ask', async () => {
		const { hooks, permissions } = await driveQuestions(
			{
				toolScope: resolveToolScope(['Read', 'ask_user'], { delegation: false }),
				askUser: async () => ({ answers: { [Q2.question]: 'Share' } }),
			},
			[call],
		)
		expect(hooks).toEqual(['none'])
		expect(permissions[0].behavior).toBe('allow')
	})

	test("a subagent's question is refused even with a host, and nobody is asked", async () => {
		let asked = 0
		const { permissions } = await driveQuestions(
			{
				askUser: async () => {
					asked += 1
					return { answers: { [Q2.question]: 'Search' } }
				},
			},
			[{ ...call, id: 'toolu_child', parent: 'toolu_task' }],
		)
		expect(asked).toBe(0)
		expect(permissions[0]).toEqual({ behavior: 'deny', message: ASK_USER_REFUSALS.subagent })
	})
})
