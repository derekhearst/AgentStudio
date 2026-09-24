<script lang="ts">
	import AskUserPreview from './AskUserPreview.svelte';
	import {
		EMPTY_SELECTION,
		chooseOther,
		optionLabel,
		previewOption,
		toggleOption,
		writeOther,
		type AskQuestion,
		type AskSelection,
	} from '$lib/engine/ask-user-question';

	/**
	 * One question the agent asked (#4): its header chip, the options as cards, a preview of
	 * the option in focus, and a free-text "Other".
	 *
	 * Controlled: the parent holds the selection (`AskUserCard`, `AskUserModal`), so moving
	 * between questions keeps what was chosen. Every rule about what a click means lives in
	 * `$lib/engine/ask-user-question` — `toggleOption`, `writeOther`, `chooseOther` — where the
	 * specs can reach it.
	 *
	 *   - Single-select: choosing an option replaces the previous one, and typing in "Other"
	 *     (or clicking "Other" itself) replaces the option. Multi-select: options toggle, and
	 *     "Other" text is added to them. Focus alone never changes the answer, so a keyboard
	 *     user can Tab past "Other" to Submit without losing the option they chose.
	 *   - "Other" is always offered for the SDK's AskUserQuestion — the model is told never to
	 *     add one itself. Only a question from the retired `ask_user` could turn it off.
	 *   - A preview is the model's HTML, rendered only inside a sandboxed frame
	 *     (`AskUserPreview`). Beside the options on a wide screen, below them otherwise.
	 */
	let {
		question,
		selection = EMPTY_SELECTION,
		onChange,
		disabled = false,
	}: {
		question: AskQuestion;
		selection?: AskSelection;
		onChange?: (next: AskSelection) => void;
		disabled?: boolean;
	} = $props();

	const uid = $props.id();

	/** The option the pointer or keyboard is on — its preview shows before it is chosen. */
	let focused = $state<string | null>(null);

	const shown = $derived(previewOption(question, selection, focused));
	const hasPreviews = $derived(question.options.some((option) => !!option.preview));
	const allowOther = $derived(question.allowFreeformInput !== false);
	const multi = $derived(question.multiSelect === true);

	function pick(label: string) {
		focused = label;
		onChange?.(toggleOption(question, selection, label));
	}

	let otherInput = $state<HTMLTextAreaElement | null>(null);

	/** "Other" clicked: choose it, and put the caret where the answer goes. */
	function pickOther() {
		const next = chooseOther(question, selection);
		onChange?.(next);
		if (next.otherChosen) otherInput?.focus();
	}

	const pickedClasses = 'border-primary bg-primary/10 ring-1 ring-primary/30';
	const idleClasses = 'border-base-300/70 bg-base-200/35 hover:border-base-300 hover:bg-base-200/60';
</script>

<div class="ask-question flex min-w-0 flex-col gap-3" data-multi-select={multi ? 'true' : 'false'}>
	<div class="flex min-w-0 flex-wrap items-center gap-2">
		{#if question.header}
			<span class="ask-question__chip badge badge-sm badge-outline border-primary/50 text-primary max-w-full shrink-0 truncate font-medium">
				{question.header}
			</span>
		{/if}
		{#if multi}
			<span class="text-base-content/60 text-xs">Choose any that apply</span>
		{/if}
	</div>

	<p class="min-w-0 text-sm leading-snug font-medium break-words">{question.question}</p>

	<div class="grid min-w-0 gap-3 {hasPreviews ? 'desktop:grid-cols-2' : ''}">
		<div class="flex min-w-0 flex-col gap-2" role="group" aria-label={question.header || question.question}>
			{#each question.options as option (option.label)}
				{@const picked = selection.selected.includes(option.label)}
				<button
					type="button"
					class="ask-option flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60 {picked
						? pickedClasses
						: idleClasses}"
					aria-pressed={picked}
					data-recommended={option.recommended ? 'true' : undefined}
					{disabled}
					onclick={() => pick(option.label)}
					onmouseenter={() => (focused = option.label)}
					onfocus={() => (focused = option.label)}
				>
					<span
						class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border {multi ? 'rounded' : 'rounded-full'} {picked
							? 'border-primary bg-primary text-primary-content'
							: 'border-base-content/30'}"
						aria-hidden="true"
					>
						{#if picked}
							<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
								<polyline points="20 6 9 17 4 12" />
							</svg>
						{/if}
					</span>
					<span class="flex min-w-0 flex-1 flex-col gap-1">
						<span class="flex min-w-0 flex-wrap items-center gap-1.5">
							<span class="min-w-0 text-sm leading-tight break-words">{optionLabel(option.label)}</span>
							{#if option.recommended}
								<span class="badge badge-xs badge-primary shrink-0">Recommended</span>
							{/if}
							{#if option.preview && shown?.label !== option.label}
								<span class="text-base-content/50 shrink-0 text-[10px] tracking-wide uppercase">Preview</span>
							{/if}
						</span>
						{#if option.description}
							<span class="text-base-content/70 text-xs leading-snug break-words">{option.description}</span>
						{/if}
					</span>
				</button>
			{/each}

			{#if allowOther}
				<div
					class="ask-option ask-option--other flex min-w-0 flex-col gap-2 rounded-xl border p-3 transition-colors duration-150 {selection.otherChosen
						? pickedClasses
						: idleClasses}"
				>
					<!--
						A button, not a label: clicking "Other" chooses it, while merely tabbing through
						it (or into the box) leaves the chosen option alone. Typing chooses it too.
					-->
					<button
						type="button"
						class="flex w-full min-w-0 cursor-pointer items-center gap-2.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60"
						aria-pressed={selection.otherChosen}
						aria-controls={`${uid}-other`}
						{disabled}
						onclick={pickOther}
					>
						<span
							class="flex h-4 w-4 shrink-0 items-center justify-center border {multi ? 'rounded' : 'rounded-full'} {selection.otherChosen
								? 'border-primary bg-primary text-primary-content'
								: 'border-base-content/30'}"
							aria-hidden="true"
						>
							{#if selection.otherChosen}
								<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
									<polyline points="20 6 9 17 4 12" />
								</svg>
							{/if}
						</span>
						<span>Other</span>
					</button>
					<textarea
						id={`${uid}-other`}
						bind:this={otherInput}
						class="textarea textarea-bordered textarea-sm min-h-14 w-full min-w-0 resize-y"
						placeholder="Type your own answer"
						aria-label="Your own answer"
						value={selection.other}
						{disabled}
						oninput={(event) => onChange?.(writeOther(question, selection, event.currentTarget.value))}
					></textarea>
				</div>
			{/if}
		</div>

		{#if shown?.preview}
			<div class="min-w-0">
				<AskUserPreview html={shown.preview} label={optionLabel(shown.label)} />
			</div>
		{/if}
	</div>
</div>
