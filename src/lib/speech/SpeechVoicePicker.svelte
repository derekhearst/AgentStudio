<script lang="ts">
	/**
	 * Settings > Model & AI: the read-aloud model and voice (#27).
	 *
	 * Two rows for the panel's grid. The model list is OpenRouter's speech catalogue with its
	 * per-character price; the voice list is whatever the chosen model says it accepts. When
	 * the catalogue is unreachable, or a model lists no voices, the field becomes free text —
	 * an empty voice means the model's own default, and it starts empty when such a model is
	 * picked. Preview reads a sample with the choices on screen, before they are saved.
	 */
	import { getSpeechModels } from './speech.remote';
	import { speechPlayer } from './speech-player.svelte';
	import { voiceForModel, type SpeechModel } from './speech';

	let {
		model,
		voice,
		onModelChange,
		onVoiceChange,
	}: {
		model: string;
		voice: string;
		onModelChange: (id: string) => void;
		onVoiceChange: (voice: string) => void;
	} = $props();

	const PREVIEW_ID = 'settings-voice-preview';
	const PREVIEW_TEXT = 'This is how replies will sound when AgentStudio reads them aloud.';

	let catalog: SpeechModel[] = $state.raw([]);
	$effect(() => {
		getSpeechModels().then((m) => (catalog = m));
	});

	const selected = $derived(catalog.find((m) => m.id === model) ?? null);
	const voices = $derived(selected?.voices ?? []);
	const previewStatus = $derived(speechPlayer.statusOf(PREVIEW_ID));
	const previewError = $derived(speechPlayer.errorOf(PREVIEW_ID));

	function perMillion(price: number | null): string {
		if (price === null) return 'price unknown';
		if (price === 0) return 'free';
		return `$${(price * 1_000_000).toFixed(2)} / 1M chars`;
	}

	function chooseModel(id: string) {
		onModelChange(id);
		// Voices are per model: see voiceForModel for what carries over.
		const nextVoice = voiceForModel(catalog.find((m) => m.id === id), voice);
		if (nextVoice !== voice) onVoiceChange(nextVoice);
	}
</script>

<!-- Read-aloud model -->
<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-3.5 last:pb-0 xl:py-3.5">
	<div>
		<p class="text-sm font-medium">Read-aloud Model</p>
		<p class="mt-0.5 text-xs text-base-content/55">Text-to-speech for the speaker button on replies (billed per character)</p>
	</div>
	<div class="w-full sm:w-64">
		{#if catalog.length > 0}
			<select
				class="select select-sm select-bordered w-full"
				aria-label="Read-aloud model"
				value={model}
				onchange={(e) => chooseModel((e.currentTarget as HTMLSelectElement).value)}
			>
				{#if !selected}
					<option value={model}>{model} (not in catalogue)</option>
				{/if}
				{#each catalog as entry (entry.id)}
					<option value={entry.id}>{entry.name} · {perMillion(entry.pricePerCharacter)}</option>
				{/each}
			</select>
		{:else}
			<input
				type="text"
				class="input input-sm input-bordered w-full font-mono text-xs"
				aria-label="Read-aloud model"
				value={model}
				oninput={(e) => onModelChange((e.currentTarget as HTMLInputElement).value.trim())}
			/>
		{/if}
	</div>
</div>

<!-- Read-aloud voice + preview -->
<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-3.5 last:pb-0 xl:py-3.5">
	<div class="min-w-0">
		<p class="text-sm font-medium">Read-aloud Voice</p>
		{#if previewError}
			<p class="mt-0.5 text-xs text-error" role="status">{previewError}</p>
		{:else}
			<p class="mt-0.5 text-xs text-base-content/55">
				{voices.length > 0 ? 'Voices offered by this model' : 'Leave empty for the model’s default voice'}
			</p>
		{/if}
	</div>
	<div class="flex w-full items-center gap-2 sm:w-64">
		{#if voices.length > 0}
			<select
				class="select select-sm select-bordered min-w-0 flex-1"
				aria-label="Read-aloud voice"
				value={voice}
				onchange={(e) => onVoiceChange((e.currentTarget as HTMLSelectElement).value)}
			>
				{#if !voices.includes(voice)}
					<option value={voice}>{voice || 'Model default'} (not offered)</option>
				{/if}
				{#each voices as name (name)}
					<option value={name}>{name}</option>
				{/each}
			</select>
		{:else}
			<input
				type="text"
				class="input input-sm input-bordered min-w-0 flex-1 font-mono text-xs"
				aria-label="Read-aloud voice"
				placeholder="Model default"
				value={voice}
				oninput={(e) => onVoiceChange((e.currentTarget as HTMLInputElement).value.trim())}
			/>
		{/if}
		<button
			type="button"
			class="btn btn-ghost btn-sm shrink-0"
			data-testid="voice-preview"
			disabled={!model}
			title={previewStatus === 'idle' ? 'Hear this voice' : 'Stop the preview'}
			aria-label={previewStatus === 'idle' ? 'Preview voice' : 'Stop preview'}
			onclick={() => speechPlayer.toggle(PREVIEW_ID, PREVIEW_TEXT, { model, voice, purpose: 'preview' })}
		>
			{#if previewStatus === 'loading'}
				<span class="loading loading-spinner loading-xs" aria-hidden="true"></span>
			{:else if previewStatus === 'playing'}
				<i class="mdi mdi-stop" aria-hidden="true"></i>
			{:else}
				<i class="mdi mdi-play-circle-outline" aria-hidden="true"></i>
			{/if}
		</button>
	</div>
</div>
