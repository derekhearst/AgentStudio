<script lang="ts">
	import ModelSelector from '$lib/llm/ModelSelector.svelte'
	import AgentSelector, { type AgentChoice } from '$lib/chat/AgentSelector.svelte'
	import Icon from '$lib/chat-console/Icon.svelte'

	type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

	const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
		{ value: 'none', label: 'off' },
		{ value: 'minimal', label: 'min' },
		{ value: 'low', label: 'low' },
		{ value: 'medium', label: 'med' },
		{ value: 'high', label: 'high' },
		{ value: 'xhigh', label: 'max' },
	]

	let {
		value = $bindable(''),
		busy = false,
		model = 'anthropic/claude-sonnet-4',
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
		class: className = '',
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
		class?: string
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

	async function submit(e: SubmitEvent) {
		e.preventDefault()
		const trimmed = value.trim()
		if (!trimmed || busy) return
		await onSubmit?.(trimmed)
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			void submit(e as unknown as SubmitEvent)
		}
	}
</script>

<form onsubmit={submit} class="console-composer-wrap {className}">
	<div class="console-composer">
		<label class="sr-only" for="chat-composer-textarea">Message</label>
		<textarea
			id="chat-composer-textarea"
			class="console-composer__ta"
			rows="5"
			{placeholder}
			bind:value
			onkeydown={handleKeydown}
			disabled={busy}
		></textarea>

		<div class="console-composer__row">
			<div class="console-composer__l">
				{#if onAddFiles}
					<button type="button" class="console-pill" disabled={busy} onclick={() => onAddFiles?.()}>
						<Icon name="plus" size={12} /> Attach
					</button>
				{/if}
				<button type="button" class="console-pill" disabled>@ Context</button>
				<button type="button" class="console-pill" disabled>/ Commands</button>
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
