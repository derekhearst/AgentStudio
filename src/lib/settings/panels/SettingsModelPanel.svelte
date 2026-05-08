<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte'
	import ModelSelector from '$lib/llm/ModelSelector.svelte'

	let {
		defaultModel,
		transcriptionModel,
		onDefaultModelChange,
		onTranscriptionModelChange,
	}: {
		defaultModel: string
		transcriptionModel: string
		onDefaultModelChange: (id: string) => void
		onTranscriptionModelChange: (id: string) => void
	} = $props()
</script>

<ContentPanel>
	{#snippet header()}
		<h2 class="flex items-center gap-2 text-base font-semibold">
			<span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
			Model & AI
		</h2>
	{/snippet}
	<div class="grid gap-x-6 gap-y-0 divide-y divide-base-300/50 xl:grid-cols-2 xl:divide-y-0">
		<!-- Default Model -->
		<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-3.5 first:pt-0 xl:py-3.5">
			<div>
				<p class="text-sm font-medium">Default Model</p>
				<p class="mt-0.5 text-xs text-base-content/55">Primary model for new conversations</p>
			</div>
			<div class="w-full sm:w-64">
				<ModelSelector
					value={defaultModel}
					showChevron={false}
					showBrowseBadge={false}
					onchange={onDefaultModelChange}
				/>
			</div>
		</div>

		<!-- Transcription Model -->
		<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-3.5 last:pb-0 xl:py-3.5">
			<div>
				<p class="text-sm font-medium">Transcription Model</p>
				<p class="mt-0.5 text-xs text-base-content/55">Model for voice-to-text (must support audio input)</p>
			</div>
			<div class="w-full sm:w-64">
				<ModelSelector
					value={transcriptionModel}
					showChevron={false}
					showBrowseBadge={false}
					requireInputModality="audio"
					onchange={onTranscriptionModelChange}
				/>
			</div>
		</div>
	</div>
</ContentPanel>
