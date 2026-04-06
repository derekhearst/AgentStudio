<script lang="ts">
	import ModelSelector from '$lib/models/ModelSelector.svelte'

	let {
		value = $bindable(''),
		busy = false,
		model = 'anthropic/claude-sonnet-4',
		placeholder = 'Message AGENTSTUDIO...',
		recording = false,
		transcribing = false,
		speechSupported = false,
		onSubmit,
		onModelChange,
		onCancelGeneration,
		onAddFiles,
		onMicClick,
		class: className = '',
	}: {
		value?: string
		busy?: boolean
		model?: string
		placeholder?: string
		recording?: boolean
		transcribing?: boolean
		speechSupported?: boolean
		onSubmit?: ((content: string) => Promise<void> | void) | undefined
		onModelChange?: ((modelId: string) => Promise<void> | void) | undefined
		onCancelGeneration?: (() => Promise<void> | void) | undefined
		onAddFiles?: (() => Promise<void> | void) | undefined
		onMicClick?: (() => Promise<void> | void) | undefined
		class?: string
	} = $props()

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

<form onsubmit={submit} class="rounded-2xl border border-base-300 bg-base-100 p-2 shadow-sm sm:rounded-3xl sm:p-3 {className}">
	<textarea
		class="w-full resize-none border-none bg-transparent px-1.5 py-1 text-base leading-6 outline-none focus:outline-none sm:px-2"
		rows="2"
		placeholder={placeholder}
		bind:value
		onkeydown={handleKeydown}
		disabled={busy}
	></textarea>

	<div class="mt-1.5 flex items-center justify-between gap-1 px-0.5 sm:mt-2 sm:gap-2 sm:px-1">
		<div class="flex items-center gap-1">
			<button
				type="button"
				class="btn btn-ghost btn-sm gap-1 rounded-full px-2 sm:gap-2"
				disabled={busy}
				onclick={() => onAddFiles?.()}
			>
				<span class="text-lg leading-none">+</span>
				<span class="hidden sm:inline">Add files</span>
			</button>
		</div>

		<div class="flex items-center gap-1">
			<div>
				<ModelSelector
					value={model}
					variant="inline"
					size="xs"
					showChevron={false}
					onchange={(id: string) => onModelChange?.(id)}
				/>
			</div>
			{#if speechSupported}
				<div class="relative flex items-center justify-center">
					{#if recording}
						<span class="mic-ripple absolute h-8 w-8 rounded-full border-2 border-error" style="animation-delay: 0s"></span>
						<span class="mic-ripple absolute h-8 w-8 rounded-full border-2 border-error" style="animation-delay: 0.4s"></span>
						<span class="mic-ripple absolute h-8 w-8 rounded-full border-2 border-error" style="animation-delay: 0.8s"></span>
					{/if}
					{#if transcribing}
						<span class="mic-ripple absolute h-8 w-8 rounded-full border-2 border-info" style="animation-delay: 0s"></span>
						<span class="mic-ripple absolute h-8 w-8 rounded-full border-2 border-info" style="animation-delay: 0.4s"></span>
					{/if}
					<button
						type="button"
						class="btn btn-sm btn-circle relative z-10 transition-colors duration-200 {recording ? 'btn-error text-error-content mic-pulse' : transcribing ? 'btn-info text-info-content' : 'btn-ghost'}"
						aria-label={recording ? 'Stop recording' : transcribing ? 'Transcribing...' : 'Voice input'}
						title={recording ? 'Stop recording' : transcribing ? 'Transcribing...' : 'Voice input'}
						disabled={busy || transcribing}
						onclick={() => onMicClick?.()}
					>
						<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<rect x="9" y="2" width="6" height="12" rx="3"></rect>
							<path d="M5 10a7 7 0 0 0 14 0"></path>
							<line x1="12" y1="17" x2="12" y2="22"></line>
							<line x1="8" y1="22" x2="16" y2="22"></line>
						</svg>
					</button>
				</div>
			{:else}
				<button
					type="button"
					class="btn btn-ghost btn-sm btn-circle opacity-30 cursor-not-allowed"
					aria-label="Voice input unavailable"
					title="Voice input not supported in this browser. Use Chrome, Edge, or Safari."
					disabled
				>
					<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<rect x="9" y="2" width="6" height="12" rx="3"></rect>
						<path d="M5 10a7 7 0 0 0 14 0"></path>
						<line x1="12" y1="17" x2="12" y2="22"></line>
						<line x1="8" y1="22" x2="16" y2="22"></line>
						<line x1="3" y1="3" x2="21" y2="21"></line>
					</svg>
				</button>
			{/if}
			{#if busy}
				<button
					type="button"
					class="btn btn-primary btn-sm btn-circle"
					aria-label="Stop generating"
					title="Stop generating"
					onclick={() => onCancelGeneration?.()}
				>
					<span class="h-3 w-3 rounded-sm bg-current"></span>
				</button>
			{:else}
				<button
					type="submit"
					class="btn btn-primary btn-sm btn-circle"
					aria-label="Send message"
					title="Send message"
					disabled={value.trim().length === 0}
				>
					<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M5 12h14"></path>
						<path d="m12 5 7 7-7 7"></path>
					</svg>
				</button>
			{/if}
		</div>
	</div>
</form>

<style>
	@keyframes mic-ripple {
		0% {
			transform: scale(1);
			opacity: 0.6;
		}
		100% {
			transform: scale(2.5);
			opacity: 0;
		}
	}

	@keyframes mic-pulse {
		0%, 100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.1);
		}
	}

	:global(.mic-ripple) {
		animation: mic-ripple 1.5s ease-out infinite;
		pointer-events: none;
	}

	:global(.mic-pulse) {
		animation: mic-pulse 1s ease-in-out infinite;
	}
</style>

