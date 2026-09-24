<script lang="ts">
	import ModelSelector from '$lib/llm/ModelSelector.svelte'
	import { getAvailableModels } from '$lib/llm/models.remote'
	import AgentSelector, { type AgentChoice } from '$lib/chat/AgentSelector.svelte'
	import ComposerSuggestMenu, { type SuggestItem } from '$lib/chat/ComposerSuggestMenu.svelte'
	import Icon from '$lib/chat-console/Icon.svelte'
	import { splitPathForDisplay, type MentionResult, type MentionSearchResult } from '$lib/chat/mention-match'
	import {
		applyCommandName,
		applyMention,
		findComposerTrigger,
		insertCommandTrigger,
		insertMentionTrigger,
		parseSlashCommand,
		sameTrigger,
		stripCommand,
		type ComposerTrigger,
		type Edit,
	} from '$lib/chat/composer-trigger'
	import {
		agentCommand,
		attachCommand,
		choiceMenu,
		effortCommand,
		findCommand,
		modelCommand,
		orderCommands,
		rankCommands,
		REASONING_OPTIONS,
		resolveChoice,
		voiceCommand,
		type ComposerChoice,
		type ComposerCommand,
	} from '$lib/chat/composer-commands'

	type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

	let {
		value = $bindable(''),
		busy = false,
		model = 'claude-sonnet-5',
		reasoningEffort = 'none',
		agentId = null,
		agentChoices = [],
		placeholder = 'Message AgentStudio…',
		recording = false,
		transcribing = false,
		speechSupported = false,
		onSubmit,
		onResearchSubmit,
		onModelChange,
		onReasoningEffortChange,
		onAgentChange,
		onCancelGeneration,
		onAddFiles,
		onMicClick,
		onMentionSearch,
		commands = [],
		class: className = '',
		size = 'default',
	}: {
		value?: string
		busy?: boolean
		model?: string
		reasoningEffort?: ReasoningEffort
		agentId?: string | null
		agentChoices?: AgentChoice[]
		placeholder?: string
		recording?: boolean
		transcribing?: boolean
		speechSupported?: boolean
		onSubmit?: ((content: string) => Promise<void> | void) | undefined
		onResearchSubmit?: ((content: string) => Promise<void> | void) | undefined
		onModelChange?: ((modelId: string) => Promise<void> | void) | undefined
		onReasoningEffortChange?: ((effort: ReasoningEffort) => Promise<void> | void) | undefined
		onAgentChange?: ((agentId: string) => Promise<void> | void) | undefined
		onCancelGeneration?: (() => Promise<void> | void) | undefined
		onAddFiles?: (() => Promise<void> | void) | undefined
		onMicClick?: (() => Promise<void> | void) | undefined
		/**
		 * #22 — search the conversation's workspace for `@`. Absent (the new-chat page, which
		 * has no conversation yet) means no `@` menu and no `@ Context` button.
		 */
		onMentionSearch?: ((query: string) => Promise<MentionSearchResult>) | undefined
		/** #22 — the page's own `/` commands, listed beside the composer's (model, agent, …). */
		commands?: ComposerCommand[]
		class?: string
		/** 'large' starts the composer tall — used on the new-chat page. */
		size?: 'default' | 'large'
	} = $props()

	let reasoningMenuOpen = $state(false)
	let reasoningRoot: HTMLDivElement | undefined = $state()
	const selectedReasoningLabel = $derived(
		REASONING_OPTIONS.find((option) => option.value === reasoningEffort)?.label ?? 'off'
	)

	$effect(() => {
		if (!reasoningMenuOpen) return

		const handleMousedown = (e: MouseEvent) => {
			if (reasoningRoot && !reasoningRoot.contains(e.target as Node)) reasoningMenuOpen = false
		}
		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') reasoningMenuOpen = false
		}

		window.addEventListener('mousedown', handleMousedown)
		window.addEventListener('keydown', handleKeydown)

		return () => {
			window.removeEventListener('mousedown', handleMousedown)
			window.removeEventListener('keydown', handleKeydown)
		}
	})

	async function submit(e?: Event) {
		e?.preventDefault()
		const trimmed = value.trim()
		if (!trimmed || busy) return
		if (await runTypedCommand()) return
		await onSubmit?.(trimmed)
		// The parent clears `value`; bring the box back down with it.
		autosize()
	}

	function handleKeydown(e: KeyboardEvent) {
		// An IME is composing (Japanese, Chinese, Korean…): Enter confirms the composition. It
		// must not send the half-typed message, and it must not pick a suggestion either.
		if (e.isComposing || e.keyCode === 229) return

		const view = menu
		if (view) {
			if (e.key === 'Escape') {
				e.preventDefault()
				// The mobile drawers close on a window-level Escape; this one is the menu's.
				e.stopPropagation()
				dismissMenu()
				return
			}
			const count = view.items.length
			const plain = !e.altKey && !e.ctrlKey && !e.metaKey
			if (count > 0 && plain) {
				if (e.key === 'ArrowDown') {
					e.preventDefault()
					chosenIndex = (active + 1) % count
					return
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault()
					chosenIndex = (active - 1 + count) % count
					return
				}
				if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
					e.preventDefault()
					void accept(active)
					return
				}
			}
			// The file search has not answered yet. Enter here would send "@READ" as typed while the
			// user is waiting for README.md, so Enter and Tab wait for the list instead.
			if (count === 0 && plain && view.kind === 'mention' && view.loading) {
				if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
					e.preventDefault()
					return
				}
			}
			// An open menu that has settled with nothing in it does not swallow Enter: the message
			// sends as typed.
		}

		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			void submit()
		}
	}

	/**
	 * Grow the textarea with its content instead of reserving five rows up front.
	 * Reset to `auto` first or scrollHeight only ever ratchets upward. The cap
	 * matches `max-height` in console.css, after which the textarea scrolls.
	 *
	 * Deliberately NOT an $effect. Writing element height from inside the reactive
	 * graph re-entered it and blew the update depth
	 * (`effect_update_depth_exceeded`), which killed Svelte's reactivity for the
	 * whole page — the stream spinner froze and navigation stopped working. This
	 * is a DOM concern driven by input, so it runs on input.
	 */
	let textarea: HTMLTextAreaElement | undefined = $state()
	// The new-chat page has nothing else on screen, so the composer is the page's
	// main affordance and starts tall. Inside a conversation the transcript is the
	// point, so it starts at one row and grows.
	const MAX_COMPOSER_HEIGHT = 168
	const minComposerHeight = () => (size === 'large' ? 120 : 22)

	function autosize(el: HTMLTextAreaElement | undefined = textarea) {
		if (!el) return
		el.style.height = 'auto'
		el.style.height = `${Math.min(Math.max(el.scrollHeight, minComposerHeight()), MAX_COMPOSER_HEIGHT)}px`
	}

	// ─────────── #22: `@` mentions and the `/` palette ───────────
	//
	// Where the caret is decides which menu is open (composer-trigger.ts). The textarea keeps
	// focus throughout; the menu is driven from handleKeydown above and never takes focus.

	const LIST_ID = 'chat-composer-suggest'
	const MENTION_DEBOUNCE_MS = 100
	const NOTICE_MS = 6000
	/** Keys that move the caret without an input event. */
	const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

	let composerEl: HTMLDivElement | undefined = $state()
	let trigger = $state<ComposerTrigger | null>(null)
	/**
	 * The row the user moved the highlight to (arrow keys, or the pointer), or null until they
	 * do. While it is null the highlight follows the menu's own starting row, which can change
	 * after the menu opens: the model list arrives, and the current model's row is only known then.
	 */
	let chosenIndex = $state<number | null>(null)
	let placement = $state<'above' | 'below'>('above')
	/** The trigger Escape closed. It stays closed until the caret leaves it. */
	let dismissed: ComposerTrigger | null = null
	/** Where the caret was when the textarea last had it, for the `@ Context` button. */
	let lastCaret: number | null = null

	let mentionResults = $state.raw<MentionResult[]>([])
	let mentionMessage = $state<string | null>(null)
	let mentionTruncated = $state(false)
	let mentionLoading = $state(false)
	let mentionSeq = 0
	let mentionTimer: ReturnType<typeof setTimeout> | undefined

	let notice = $state<{ text: string; tone: 'info' | 'error' } | null>(null)
	let noticeTimer: ReturnType<typeof setTimeout> | undefined

	/** The model list for `/model`, fetched the first time the palette asks for it. */
	let models = $state.raw<Array<{ id: string; name: string }> | null>(null)
	let modelsRequested = false
	function modelList() {
		if (!modelsRequested) {
			modelsRequested = true
			getAvailableModels()
				.then((list) => (models = list))
				.catch(() => (models = []))
		}
		return models
	}

	/** The composer's own commands: one for each control it already has. */
	const builtinCommands = $derived.by(() => {
		const list: ComposerCommand[] = []
		if (onModelChange) {
			list.push(modelCommand({ current: () => model, models: modelList, pick: (id) => onModelChange?.(id) }))
		}
		if (onAgentChange && agentChoices.length > 0) {
			list.push(
				agentCommand({ current: () => agentId ?? null, agents: () => agentChoices, pick: (id) => onAgentChange?.(id) }),
			)
		}
		if (onReasoningEffortChange) {
			list.push(effortCommand({ current: () => reasoningEffort, pick: (effort) => onReasoningEffortChange?.(effort) }))
		}
		if (onAddFiles) list.push(attachCommand(() => onAddFiles?.()))
		if (speechSupported && onMicClick) {
			list.push(
				voiceCommand({ recording: () => recording, transcribing: () => transcribing, toggle: () => onMicClick?.() }),
			)
		}
		return list
	})
	const allCommands = $derived(orderCommands([...builtinCommands, ...commands]))

	type MenuBase = {
		title: string
		items: SuggestItem[]
		/** The row highlighted until the user moves it. */
		initial: number
		loading: boolean
		emptyText: string
		footer: string | null
	}
	type MenuView = MenuBase &
		(
			| { kind: 'mention'; entries: MentionResult[] }
			| { kind: 'command'; entries: ComposerCommand[] }
			| { kind: 'choice'; command: ComposerCommand; entries: ComposerChoice[] }
			| { kind: 'hint' }
		)

	function mentionItem(result: MentionResult): SuggestItem {
		const shown = splitPathForDisplay(result.path, result.indices)
		return {
			id: result.path,
			label: shown.name,
			labelIndices: shown.nameIndices,
			detail: shown.folder || undefined,
			detailIndices: shown.folderIndices,
			icon: result.isDirectory ? 'folder' : 'file',
		}
	}

	function commandItem(command: ComposerCommand, nameIndices: number[]): SuggestItem {
		const unavailable = command.unavailable?.() ?? null
		return {
			id: command.name,
			label: `/${command.name}`,
			// Shifted past the slash.
			labelIndices: nameIndices.map((i) => i + 1),
			hint: command.argument?.placeholder,
			detail: unavailable ?? command.description,
			icon: 'terminal',
			badge: command.status?.() ?? undefined,
			disabled: Boolean(unavailable),
		}
	}

	const menu = $derived.by((): MenuView | null => {
		if (busy || !trigger) return null
		if (trigger.kind === 'mention') {
			if (!onMentionSearch) return null
			return {
				kind: 'mention',
				title: 'Files in this chat’s workspace',
				entries: mentionResults,
				items: mentionResults.map(mentionItem),
				initial: 0,
				loading: mentionLoading,
				emptyText:
					mentionMessage ?? (trigger.query ? `No files match “${trigger.query}”.` : 'This workspace has no files yet.'),
				footer: mentionTruncated ? 'Large workspace: only part of it was searched.' : null,
			}
		}
		if (trigger.kind === 'command') {
			const ranked = rankCommands(trigger.query, allCommands)
			return {
				kind: 'command',
				title: 'Commands',
				entries: ranked.map((match) => match.item),
				items: ranked.map((match) => commandItem(match.item, match.key === 0 ? match.indices : [])),
				initial: 0,
				loading: false,
				emptyText: 'No matching command. Enter sends the message as typed.',
				footer: null,
			}
		}
		const command = findCommand(allCommands, trigger.name)
		if (!command?.argument) return null
		if (command.argument.kind === 'text') {
			return {
				kind: 'hint',
				title: `/${command.name} ${command.argument.placeholder}`,
				items: [],
				initial: 0,
				loading: false,
				emptyText: command.argument.hint,
				footer: null,
			}
		}
		const choices = command.argument.choices()
		// The rows and the row to start on, worked out together, so the start is a row on screen.
		const { matches: ranked, initial } = choiceMenu(trigger.query, choices ?? [])
		return {
			kind: 'choice',
			command,
			title: `/${command.name}: ${command.description}`,
			entries: ranked.map((match) => match.item),
			initial,
			items: ranked.map(({ item, indices, key }) => ({
				id: item.id,
				label: item.label,
				labelIndices: key === 0 ? indices : [],
				detail: item.detail,
				detailIndices: key === 1 && item.detail === item.id ? indices : [],
				badge: item.current ? 'current' : undefined,
			})),
			loading: choices === null,
			emptyText: choices === null ? 'Loading…' : `No ${command.argument.noun} matches “${trigger.query}”.`,
			footer: null,
		}
	})

	const active = $derived(
		menu && menu.items.length > 0 ? Math.min(chosenIndex ?? menu.initial, menu.items.length - 1) : 0,
	)
	const menuOpen = $derived(menu !== null)
	const listOpen = $derived(menu !== null && menu.items.length > 0)

	// Open above the composer, unless it sits near the top of the screen (the new-chat page on
	// a phone) with more room below.
	$effect(() => {
		if (!menuOpen || !composerEl) return
		const rect = composerEl.getBoundingClientRect()
		placement = rect.top < 240 && window.innerHeight - rect.bottom > rect.top ? 'below' : 'above'
	})

	$effect(() => () => {
		clearTimeout(mentionTimer)
		clearTimeout(noticeTimer)
	})

	/** Re-read the caret, then open, update or close the menu to match it. */
	function refreshTrigger() {
		const el = textarea
		if (!el || busy) return closeMenu()
		lastCaret = el.selectionStart
		if (el.selectionStart !== el.selectionEnd) return closeMenu()
		const next = findComposerTrigger(el.value, el.selectionStart)
		if (next && dismissed && next.kind === dismissed.kind && next.start === dismissed.start) {
			trigger = null
			return
		}
		dismissed = null
		if (sameTrigger(trigger, next)) return
		const previous = trigger
		trigger = next
		// A new trigger, or a new query: the highlight goes back to the menu's own starting row.
		chosenIndex = null
		if (next?.kind === 'mention') {
			// A different `@` from the one on screen: its old results would be wrong, not just stale.
			if (previous?.kind !== 'mention' || previous.start !== next.start) {
				mentionResults = []
				mentionMessage = null
				mentionTruncated = false
			}
			scheduleMentionSearch(next.query)
		} else {
			cancelMentionSearch()
		}
	}

	function closeMenu() {
		trigger = null
		cancelMentionSearch()
	}

	function dismissMenu() {
		dismissed = trigger
		closeMenu()
	}

	function scheduleMentionSearch(query: string) {
		const search = onMentionSearch
		if (!search) return
		clearTimeout(mentionTimer)
		const seq = ++mentionSeq
		mentionLoading = true
		mentionTimer = setTimeout(async () => {
			try {
				const result = await search(query)
				if (seq !== mentionSeq) return
				if (result.ok) {
					mentionResults = result.results
					mentionTruncated = result.truncated
					mentionMessage = null
				} else {
					mentionResults = []
					mentionTruncated = false
					mentionMessage = result.message
				}
			} catch {
				if (seq !== mentionSeq) return
				mentionResults = []
				mentionTruncated = false
				mentionMessage = 'Could not search this chat’s files.'
			} finally {
				if (seq === mentionSeq) mentionLoading = false
			}
		}, MENTION_DEBOUNCE_MS)
	}

	function cancelMentionSearch() {
		clearTimeout(mentionTimer)
		mentionSeq++
		mentionLoading = false
	}

	function showNotice(text: string, tone: 'info' | 'error') {
		clearTimeout(noticeTimer)
		notice = { text, tone }
		noticeTimer = setTimeout(() => (notice = null), NOTICE_MS)
	}

	/**
	 * Put new text in the box and the caret where it belongs, and bring the menu in step.
	 *
	 * Synchronous, and straight onto the element rather than after `tick()`: with async
	 * deriveds on the page, `tick()` can wait on unrelated work, and a keystroke that lands in
	 * between goes to the old caret. The binding then finds the element already holding the
	 * value and leaves it (and the caret) alone.
	 */
	function applyEdit(edit: Edit) {
		value = edit.value
		trigger = null
		const el = textarea
		if (!el) return
		if (el.value !== edit.value) el.value = edit.value
		// Caret first, so the focus handler reads the new position, and again after, for
		// browsers that move it on focus.
		el.setSelectionRange(edit.caret, edit.caret)
		el.focus()
		el.setSelectionRange(edit.caret, edit.caret)
		autosize(el)
		refreshTrigger()
	}

	async function runCommand(command: ComposerCommand, argument: string) {
		try {
			const outcome = await command.run(argument)
			if (typeof outcome === 'string' && outcome) showNotice(outcome, 'info')
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 'error')
		}
	}

	async function accept(index: number) {
		const view = menu
		const current = trigger
		if (!view || !current) return
		if (view.kind === 'mention' && current.kind === 'mention') {
			const entry = view.entries[index]
			if (entry) applyEdit(applyMention(value, current, entry.path))
			return
		}
		if (view.kind === 'command' && current.kind === 'command') {
			const command = view.entries[index]
			if (!command) return
			const unavailable = command.unavailable?.()
			if (unavailable) return showNotice(unavailable, 'error')
			if (command.argument) {
				// It takes an argument: `/name ` goes in, and its choice list or its hint opens.
				applyEdit(applyCommandName(value, current, command.name))
				return
			}
			const rest = stripCommand(value, { consumeLine: false })
			applyEdit({ value: rest, caret: rest.length })
			await runCommand(command, '')
			return
		}
		if (view.kind === 'choice') {
			const choice = view.entries[index]
			if (!choice) return
			const rest = stripCommand(value, { consumeLine: true })
			applyEdit({ value: rest, caret: rest.length })
			await runCommand(view.command, choice.id)
		}
	}

	/**
	 * A message that starts with one of the palette's commands runs the command instead of
	 * being sent: `/compact`, `/research why is the sky blue`, `/effort high`. Anything else
	 * that starts with a slash is sent as typed.
	 */
	async function runTypedCommand(): Promise<boolean> {
		const parsed = parseSlashCommand(value)
		if (!parsed) return false
		const command = findCommand(allCommands, parsed.name)
		if (!command) return false
		closeMenu()

		const unavailable = command.unavailable?.()
		if (unavailable) {
			showNotice(unavailable, 'error')
			return true
		}

		const argument = command.argument
		let runWith: string
		let rest: string
		if (!argument) {
			runWith = ''
			rest = stripCommand(value, { consumeLine: false })
		} else if (argument.kind === 'text') {
			// The text is the rest of the command's line. Lines below it are the draft the
			// `/ Commands` button moved down, and they stay in the box, as with every command.
			if (!parsed.lineArgument) {
				showNotice(argument.hint, 'info')
				return true
			}
			runWith = parsed.lineArgument
			rest = stripCommand(value, { consumeLine: true })
		} else {
			const choices = argument.choices()
			if (!choices) {
				showNotice(`Still loading the ${argument.noun} list. Try again in a moment.`, 'info')
				return true
			}
			const choice = resolveChoice(choices, parsed.lineArgument)
			if (!choice) {
				showNotice(
					parsed.lineArgument
						? `No ${argument.noun} matches “${parsed.lineArgument}”.`
						: `Pick a ${argument.noun} from the list.`,
					'error',
				)
				return true
			}
			runWith = choice.id
			rest = stripCommand(value, { consumeLine: true })
		}

		applyEdit({ value: rest, caret: rest.length })
		await runCommand(command, runWith)
		return true
	}

	/** The `@ Context` button: an `@` at the caret, and the file list open on the whole tree. */
	function openMentionMenu() {
		if (busy || !onMentionSearch) return
		dismissed = null
		applyEdit(insertMentionTrigger(value, lastCaret ?? value.length))
	}

	/** The `/ Commands` button: the palette, with any draft kept on the lines below. */
	function openCommandMenu() {
		if (busy) return
		dismissed = null
		applyEdit(insertCommandTrigger(value))
	}
</script>

<form onsubmit={submit} class="console-composer-wrap {className} {size === 'large' ? 'is-large' : ''}">
	<!-- On a phone the left-hand pills are hidden (console.css), so these stand in for them. -->
	<div class="console-quick">
		{#if onAddFiles}
			<button type="button" disabled={busy} onclick={() => onAddFiles?.()}>
				<Icon name="plus" size={12} /> Attach
			</button>
		{/if}
		{#if onMentionSearch}
			<button type="button" disabled={busy} onclick={openMentionMenu}>@ Context</button>
		{/if}
		<button type="button" disabled={busy} onclick={openCommandMenu}>/ Commands</button>
	</div>

	<div class="console-composer" bind:this={composerEl}>
		{#if menu}
			<ComposerSuggestMenu
				listId={LIST_ID}
				title={menu.title}
				items={menu.items}
				activeIndex={active}
				loading={menu.loading}
				emptyText={menu.emptyText}
				footer={menu.footer}
				{placement}
				onPick={(index) => void accept(index)}
				onHover={(index) => (chosenIndex = index)}
			/>
		{/if}

		{#if notice}
			<p
				class="console-composer__notice"
				class:is-error={notice.tone === 'error'}
				role={notice.tone === 'error' ? 'alert' : 'status'}
				data-testid="composer-notice"
			>
				{notice.text}
			</p>
		{/if}

		<label class="sr-only" for="chat-composer-textarea">Message</label>
		<textarea
			bind:this={textarea}
			oninput={(e) => {
				autosize(e.currentTarget)
				refreshTrigger()
			}}
			onclick={refreshTrigger}
			onfocus={refreshTrigger}
			onblur={closeMenu}
			onkeyup={(e) => {
				if (CARET_KEYS.has(e.key)) refreshTrigger()
			}}
			id="chat-composer-textarea"
			class="console-composer__ta"
			rows="1"
			{placeholder}
			bind:value
			onkeydown={handleKeydown}
			disabled={busy}
			aria-autocomplete="list"
			aria-controls={listOpen ? LIST_ID : undefined}
			aria-activedescendant={listOpen ? `${LIST_ID}-${active}` : undefined}
		></textarea>

		<div class="console-composer__row">
			<div class="console-composer__l">
				{#if onAddFiles}
					<button type="button" class="console-pill" disabled={busy} onclick={() => onAddFiles?.()}>
						<Icon name="plus" size={12} /> Attach
					</button>
				{/if}
				{#if onMentionSearch}
					<button
						type="button"
						class="console-pill"
						disabled={busy}
						title="Mention a file from this chat’s workspace (or type @)"
						onclick={openMentionMenu}
					>
						@ Context
					</button>
				{/if}
				<button
					type="button"
					class="console-pill"
					disabled={busy}
					title="Run a command (or type / at the start of the message)"
					onclick={openCommandMenu}
				>
					/ Commands
				</button>
			</div>

			<div class="console-composer__r">
				<AgentSelector
					{agentId}
					{agentChoices}
					{busy}
					onAgentChange={(next) => onAgentChange?.(next)}
				/>
				<ModelSelector
					value={model}
					variant="inline"
					size="xs"
					showChevron={true}
					onchange={(id: string) => onModelChange?.(id)}
				/>
				<div bind:this={reasoningRoot} class="dropdown dropdown-top dropdown-end" class:dropdown-open={reasoningMenuOpen}>
					<button
						type="button"
						class="console-pill"
						title="Reasoning effort"
						aria-label="Reasoning effort"
						aria-expanded={reasoningMenuOpen}
						disabled={busy}
						onclick={() => { reasoningMenuOpen = !reasoningMenuOpen }}
					>
						<span class="truncate">reasoning:{selectedReasoningLabel}</span>
						<span class="ar">▾</span>
					</button>
					{#if reasoningMenuOpen}
						<ul class="menu dropdown-content bg-base-100 border-base-300 rounded-box z-30 mb-2 w-32 border p-1 shadow-xl">
							{#each REASONING_OPTIONS as option (option.value)}
								<li>
									<button
										type="button"
										class:menu-active={option.value === reasoningEffort}
										onclick={() => {
											reasoningMenuOpen = false
											onReasoningEffortChange?.(option.value)
										}}
									>
										{option.label}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				{#if speechSupported}
					<button
						type="button"
						class="console-pill"
						aria-label={recording ? 'Stop recording' : transcribing ? 'Transcribing…' : 'Voice input'}
						title={recording ? 'Stop recording' : transcribing ? 'Transcribing…' : 'Voice input'}
						disabled={busy || transcribing}
						onclick={() => onMicClick?.()}
					>
						<Icon name="mic" size={12} />
					</button>
				{/if}

				{#if onResearchSubmit}
					<button
						type="button"
						class="console-pill"
						aria-label="Research"
						title="Submit as research request"
						disabled={busy || value.trim().length === 0}
						onclick={async () => {
							const trimmed = value.trim()
							if (!trimmed || busy) return
							const captured = trimmed
							value = ''
							await onResearchSubmit?.(captured)
						}}
					>
						<Icon name="search" size={12} /> Research
					</button>
				{/if}

				{#if busy}
					<button
						type="button"
						class="console-send cancel"
						aria-label="Stop generating"
						title="Stop generating"
						onclick={() => onCancelGeneration?.()}
					>
						<span style="width:10px;height:10px;background:currentColor;border-radius:1px;display:inline-block;"></span>
					</button>
				{:else}
					<button
						type="submit"
						class="console-send"
						aria-label="Send message"
						title="Send message"
						disabled={value.trim().length === 0}
					>
						<Icon name="send" size={14} />
					</button>
				{/if}
			</div>
		</div>
	</div>
</form>
