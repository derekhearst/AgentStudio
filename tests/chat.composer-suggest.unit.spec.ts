import { expect, test } from '@playwright/test'
import {
	applyCommandName,
	applyMention,
	findComposerTrigger,
	findMentionTrigger,
	findSlashTrigger,
	formatMentionPath,
	insertCommandTrigger,
	insertMentionTrigger,
	MAX_TRIGGER_QUERY,
	parseSlashCommand,
	stripCommand,
	type CommandTrigger,
	type MentionTrigger,
} from '../src/lib/chat/composer-trigger'
import { fuzzyMatch, highlightSegments, rankItems, rankPaths, splitPathForDisplay } from '../src/lib/chat/mention-match'
import {
	agentCommand,
	compactCommand,
	effortCommand,
	findCommand,
	modelCommand,
	nextPlanMode,
	orderCommands,
	planModeCommand,
	rankCommands,
	researchCommand,
	resolveChoice,
	type ComposerCommand,
} from '../src/lib/chat/composer-commands'

/**
 * #22 — the composer's `@` mentions and `/` palette, as pure functions: where a trigger is,
 * what accepting a suggestion does to the text, how candidates rank, and what each command
 * runs. The UI spec (chat.composer-mentions.spec.ts) drives the same code through the page.
 */

test.describe('composer trigger — @ mentions', () => {
	test('an @ at the start or after whitespace, ( or [ opens a mention', () => {
		expect(findMentionTrigger('@src', 4)).toEqual({ kind: 'mention', start: 0, end: 4, query: 'src' })
		expect(findMentionTrigger('see @pin', 8)).toEqual({ kind: 'mention', start: 4, end: 8, query: 'pin' })
		expect(findMentionTrigger('line one\n@a', 11)).toMatchObject({ start: 9, query: 'a' })
		expect(findMentionTrigger('(@lib', 5)).toMatchObject({ start: 1, query: 'lib' })
		expect(findMentionTrigger('[@lib', 5)).toMatchObject({ start: 1, query: 'lib' })
		// Just the @: an empty query, which lists the top of the tree.
		expect(findMentionTrigger('look at @', 9)).toMatchObject({ start: 8, query: '' })
	})

	test('an email address or an @ inside a word is not a mention', () => {
		expect(findMentionTrigger('me@example.com', 14)).toBeNull()
		expect(findMentionTrigger('a@b', 3)).toBeNull()
		expect(findMentionTrigger('x`@y', 4)).toBeNull()
	})

	test('the caret must be inside the token; the query is the whole token', () => {
		// Caret in the middle: still that token, and the query runs to its end.
		expect(findMentionTrigger('@src/lib next', 3)).toEqual({ kind: 'mention', start: 0, end: 8, query: 'src/lib' })
		// Caret after the space that ends it: no longer a mention.
		expect(findMentionTrigger('@src ', 5)).toBeNull()
		expect(findMentionTrigger('@src', 0)).toBeNull()
	})

	test('a query longer than the limit closes the menu instead of searching', () => {
		const long = `@${'a'.repeat(MAX_TRIGGER_QUERY + 1)}`
		expect(findMentionTrigger(long, long.length)).toBeNull()
		const fits = `@${'a'.repeat(MAX_TRIGGER_QUERY)}`
		expect(findMentionTrigger(fits, fits.length)?.query.length).toBe(MAX_TRIGGER_QUERY)
	})

	test('accepting replaces @query with the backticked path and one space', () => {
		const trigger = findMentionTrigger('check @pin please', 10) as MentionTrigger
		const edit = applyMention('check @pin please', trigger, 'docs/pinned.md')
		// The existing space after the token is reused, not doubled.
		expect(edit.value).toBe('check `docs/pinned.md` please')
		expect(edit.value.slice(0, edit.caret)).toBe('check `docs/pinned.md`')

		const atEnd = findMentionTrigger('open @ap', 8) as MentionTrigger
		const second = applyMention('open @ap', atEnd, 'src/app.ts')
		expect(second).toEqual({ value: 'open `src/app.ts` ', caret: 'open `src/app.ts` '.length })
	})

	test('a path with a backtick in it gets a longer fence', () => {
		expect(formatMentionPath('a/b.ts')).toBe('`a/b.ts`')
		expect(formatMentionPath('odd`name.md')).toBe('`` odd`name.md ``')
	})

	test('the @ Context button inserts an @, spaced off the previous word', () => {
		expect(insertMentionTrigger('', 0)).toEqual({ value: '@', caret: 1 })
		expect(insertMentionTrigger('fix', 3)).toEqual({ value: 'fix @', caret: 5 })
		expect(insertMentionTrigger('fix ', 4)).toEqual({ value: 'fix @', caret: 5 })
		expect(insertMentionTrigger('ab', 1)).toEqual({ value: 'a @b', caret: 3 })
	})
})

test.describe('composer trigger — / commands', () => {
	test('a slash opens the palette only as the first character', () => {
		expect(findSlashTrigger('/', 1)).toEqual({ kind: 'command', start: 0, end: 1, query: '' })
		expect(findSlashTrigger('/mo', 3)).toEqual({ kind: 'command', start: 0, end: 3, query: 'mo' })
		expect(findSlashTrigger('hello /mo', 9)).toBeNull()
		expect(findSlashTrigger(' /mo', 4)).toBeNull()
	})

	test('a path is not a command', () => {
		expect(findSlashTrigger('/usr/bin is broken', 4)).toBeNull()
		expect(parseSlashCommand('/usr/bin is broken')).toBeNull()
	})

	test('after the command word, the rest of the first line is its argument', () => {
		expect(findSlashTrigger('/model son', 10)).toEqual({ kind: 'argument', name: 'model', start: 7, end: 10, query: 'son' })
		expect(findSlashTrigger('/Model  ', 8)).toMatchObject({ kind: 'argument', name: 'model', query: '' })
		// The caret on a later line is outside the command.
		expect(findSlashTrigger('/model\nhello', 10)).toBeNull()
	})

	test('a mention inside a command argument still completes', () => {
		const value = '/research compare @src'
		expect(findComposerTrigger(value, value.length)).toMatchObject({ kind: 'mention', query: 'src' })
		expect(findComposerTrigger('/research compare', 17)).toMatchObject({ kind: 'argument', name: 'research' })
	})

	test('the / Commands button keeps a draft on the line below', () => {
		expect(insertCommandTrigger('')).toEqual({ value: '/', caret: 1 })
		expect(insertCommandTrigger('   ')).toEqual({ value: '/', caret: 1 })
		expect(insertCommandTrigger('my draft')).toEqual({ value: '/\nmy draft', caret: 1 })
		// Already a command: back to the end of its word, not a second slash.
		expect(insertCommandTrigger('/mod x')).toEqual({ value: '/mod x', caret: 4 })
	})

	test('picking a command that takes an argument writes `/name ` and keeps the rest', () => {
		const trigger = findSlashTrigger('/res', 4) as CommandTrigger
		expect(applyCommandName('/res', trigger, 'research')).toEqual({ value: '/research ', caret: 10 })
		const withDraft = findSlashTrigger('/m\ndraft', 2) as CommandTrigger
		expect(applyCommandName('/m\ndraft', withDraft, 'model')).toEqual({ value: '/model \ndraft', caret: 7 })
	})

	test('removing a command leaves the draft', () => {
		expect(stripCommand('/compact', { consumeLine: false })).toBe('')
		expect(stripCommand('/compact\nmy draft', { consumeLine: false })).toBe('my draft')
		expect(stripCommand('/compact and more', { consumeLine: false })).toBe('and more')
		// A choice consumes its own line.
		expect(stripCommand('/model sonnet\nmy draft', { consumeLine: true })).toBe('my draft')
		expect(stripCommand('not a command', { consumeLine: true })).toBe('not a command')
	})

	test('parsing a sent message', () => {
		expect(parseSlashCommand('/Research why\nand how')).toEqual({
			name: 'research',
			argument: 'why\nand how',
			lineArgument: 'why',
		})
		expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', argument: '', lineArgument: '' })
		expect(parseSlashCommand('/')).toBeNull()
		expect(parseSlashCommand('hello')).toBeNull()
	})
})

test.describe('fuzzy ranking', () => {
	test('a subsequence matches case-insensitively; anything else does not', () => {
		expect(fuzzyMatch('mm', 'mention-match')?.indices).toEqual([0, 8])
		expect(fuzzyMatch('PIN', 'PinnedTodo')).not.toBeNull()
		expect(fuzzyMatch('xyz', 'mention-match')).toBeNull()
		expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] })
	})

	test('word starts and adjacent runs beat scattered letters', () => {
		const boundary = fuzzyMatch('ct', 'ChatTodo')!
		const scattered = fuzzyMatch('ct', 'accent')!
		expect(boundary.score).toBeGreaterThan(scattered.score)
		// The best alignment, not the first one: `st` should land on "s-tream" at the boundary.
		expect(fuzzyMatch('st', 'last/stream')!.indices).toEqual([5, 6])
	})

	test('a match in the file name beats the same letters spread over folders', () => {
		const ranked = rankPaths('pin', [
			'docs/deep/nested/pin/readme.md',
			'src/lib/chat/PinnedTodoPanel.svelte',
			'spinner.css',
			'pin.ts',
		])
		expect(ranked[0].path).toBe('pin.ts')
		expect(ranked[1].path).toBe('src/lib/chat/PinnedTodoPanel.svelte')
		expect(ranked.map((r) => r.path)).toContain('spinner.css')
		// Highlight positions point into the full path.
		const pinned = ranked.find((r) => r.path.endsWith('PinnedTodoPanel.svelte'))!
		expect(pinned.indices.map((i) => pinned.path[i]).join('').toLowerCase()).toBe('pin')
	})

	test('a query with a slash narrows by folder', () => {
		const ranked = rankPaths('chat/in', ['src/lib/chat/ChatInput.svelte', 'src/lib/chat-console/Icon.svelte', 'docs/index.md'])
		expect(ranked[0].path).toBe('src/lib/chat/ChatInput.svelte')
		expect(ranked.map((r) => r.path)).not.toContain('docs/index.md')
	})

	test('no query shows the top of the tree, folders first', () => {
		const ranked = rankPaths('', ['src/app.ts', 'README.md', 'src/', 'docs/', 'docs/a.md', 'package.json'])
		expect(ranked.map((r) => r.path)).toEqual(['docs/', 'src/', 'package.json', 'README.md', 'docs/a.md', 'src/app.ts'])
		expect(ranked[0].isDirectory).toBe(true)
	})

	test('results are capped', () => {
		const paths = Array.from({ length: 100 }, (_, i) => `file-${i}.ts`)
		expect(rankPaths('file', paths, 20)).toHaveLength(20)
		expect(rankPaths('', paths, 5)).toHaveLength(5)
	})

	test('a very long candidate still matches (greedy fallback)', () => {
		const long = `${'a/'.repeat(3000)}target.ts`
		expect(fuzzyMatch('tgt', long)).not.toBeNull()
	})

	test('highlight segments and the name/folder split', () => {
		expect(highlightSegments('abc', [0, 2])).toEqual([
			{ text: 'a', match: true },
			{ text: 'b', match: false },
			{ text: 'c', match: true },
		])
		expect(highlightSegments('abc')).toEqual([{ text: 'abc', match: false }])
		expect(splitPathForDisplay('src/lib/app.ts', [0, 8])).toEqual({
			name: 'app.ts',
			nameIndices: [0],
			folder: 'src/lib/',
			folderIndices: [0],
		})
		expect(splitPathForDisplay('src/lib/', [])).toMatchObject({ name: 'lib/', folder: 'src/' })
	})

	test('rankItems prefers the primary key over an alias, and keeps order for an empty query', () => {
		const items = [
			{ name: 'effort', aliases: ['reasoning'] },
			{ name: 'research', aliases: [] },
		]
		const keys = (item: (typeof items)[number]) => [item.name, ...item.aliases]
		expect(rankItems('', items, keys).map((r) => r.item.name)).toEqual(['effort', 'research'])
		const byAlias = rankItems('reason', items, keys)
		expect(byAlias[0].item.name).toBe('effort')
		expect(byAlias[0].key).toBe(1)
	})
})

test.describe('palette commands', () => {
	function recorder() {
		const calls: string[] = []
		return { calls, push: (label: string) => calls.push(label) }
	}

	test('ordered, deduplicated by name, and found by alias', () => {
		const noop = () => {}
		const commands = orderCommands([
			effortCommand({ current: () => 'none', pick: noop }),
			researchCommand(noop),
			compactCommand(noop),
			{ name: 'custom', description: 'x', run: noop },
			// A page's command replaces a default of the same name.
			{ ...compactCommand(noop), description: 'page compact' },
		])
		expect(commands.map((c) => c.name)).toEqual(['compact', 'research', 'effort', 'custom'])
		expect(commands[0].description).toBe('page compact')
		expect(findCommand(commands, 'REASONING')?.name).toBe('effort')
		expect(findCommand(commands, 'nope')).toBeNull()
		expect(rankCommands('comp', commands)[0].item.name).toBe('compact')
	})

	test('/compact and /research call the page handlers they were given', async () => {
		const log = recorder()
		await compactCommand(() => log.push('compact')).run('')
		await researchCommand((q) => log.push(`research:${q}`)).run('why is the sky blue')
		expect(log.calls).toEqual(['compact', 'research:why is the sky blue'])
	})

	test('/plan flips between Plan only and Ask, and never lands on a looser mode', async () => {
		expect(nextPlanMode('plan')).toBe('default')
		expect(nextPlanMode('default')).toBe('plan')
		expect(nextPlanMode('acceptEdits')).toBe('plan')
		expect(nextPlanMode('bypassPermissions')).toBe('plan')
		expect(nextPlanMode('garbage')).toBe('plan')

		let mode: string = 'default'
		const plan = planModeCommand({ current: () => mode, setMode: (next) => void (mode = next) })
		expect(plan.status?.()).toBeNull()
		expect(await plan.run('')).toMatch(/Plan mode is on/)
		expect(mode).toBe('plan')
		expect(plan.status?.()).toBe('on')
		expect(await plan.run('')).toMatch(/Plan mode is off/)
		expect(mode).toBe('default')
	})

	test('/model, /agent and /effort offer choices and mark the current one', async () => {
		const log = recorder()
		const model = modelCommand({
			current: () => 'anthropic/claude-sonnet-5',
			models: () => [
				{ id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
				{ id: 'openai/gpt-6', name: 'GPT-6' },
			],
			pick: (id) => log.push(`model:${id}`),
		})
		const choices = model.argument?.kind === 'choice' ? model.argument.choices() : null
		expect(choices?.find((c) => c.current)?.id).toBe('anthropic/claude-sonnet-5')
		expect(await model.run('openai/gpt-6')).toBe('Model: GPT-6')

		const loading = modelCommand({ current: () => 'x', models: () => null, pick: () => {} })
		expect(loading.argument?.kind === 'choice' && loading.argument.choices()).toBeNull()

		const agent = agentCommand({
			current: () => 'a1',
			agents: () => [
				{ id: 'a1', name: 'Chat', role: 'General' },
				{ id: 'a2', name: 'Plan', role: 'Planner' },
			],
			pick: (id) => log.push(`agent:${id}`),
		})
		expect(await agent.run('a2')).toBe('Agent: Plan')

		const effort = effortCommand({ current: () => 'none', pick: (e) => log.push(`effort:${e}`) })
		expect(await effort.run('high')).toBe('Reasoning effort: high')
		// Not one of the levels: nothing happens.
		expect(await effort.run('turbo')).toBeUndefined()

		expect(log.calls).toEqual(['model:openai/gpt-6', 'agent:a2', 'effort:high'])
	})

	test('a typed choice resolves by exact label or id first, then fuzzily', () => {
		const choices = [
			{ id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
			{ id: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
			{ id: 'none', label: 'off' },
		]
		expect(resolveChoice(choices, 'claude opus 5')?.id).toBe('anthropic/claude-opus-5')
		expect(resolveChoice(choices, 'anthropic/claude-sonnet-5')?.id).toBe('anthropic/claude-sonnet-5')
		expect(resolveChoice(choices, 'opus')?.id).toBe('anthropic/claude-opus-5')
		expect(resolveChoice(choices, 'off')?.id).toBe('none')
		expect(resolveChoice(choices, 'zzz')).toBeNull()
		expect(resolveChoice(choices, '')).toBeNull()
	})

	test('a command is plain data, so an SDK-reported one can sit beside the app’s', () => {
		const sdk: ComposerCommand = { name: 'review', description: 'Review the diff', source: 'sdk', run: () => {} }
		const ordered = orderCommands([compactCommand(() => {}), sdk])
		expect(ordered.map((c) => c.name)).toEqual(['compact', 'review'])
		expect(ordered[1].source).toBe('sdk')
	})
})
