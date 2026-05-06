<script lang="ts">
	type AskUserOption = {
		label: string
		description?: string
		recommended?: boolean
	}

	type AskUserQuestion = {
		header: string
		question: string
		options: AskUserOption[]
		allowFreeformInput?: boolean
	}

	let {
		question,
		value = '',
		onChange,
	} = $props<{
		question: AskUserQuestion
		value?: string
		onChange?: ((value: string) => void) | undefined
	}>()

	const optionLabels = $derived(new Set((question.options ?? []).map((option: AskUserOption) => option.label)))
	const isCustomValue = $derived(value.trim().length > 0 && !optionLabels.has(value))

	function selectOption(label: string) {
		onChange?.(label)
	}

	function updateCustomAnswer(next: string) {
		onChange?.(next)
	}

	function handleCustomFocus() {
		if (!isCustomValue) {
			onChange?.('')
		}
	}
</script>

<div class="space-y-2">
	{#if question.options.length > 0}
		<div class="space-y-2">
			{#each question.options as option (option.label)}
				<button
					type="button"
					class="card card-compact card-border w-full cursor-pointer p-3 text-left transition-colors duration-150 {value === option.label
						? 'border-primary bg-primary/15 ring-primary/25 ring-1'
						: 'border-base-300/70 bg-base-200/35 hover:border-base-300 hover:bg-base-200/55'}"
					onclick={() => selectOption(option.label)}
				>
					<span class="block text-sm leading-tight">{option.label}</span>
					{#if option.description}
						<span class="mt-1 block text-[11px] leading-tight opacity-70">{option.description}</span>
					{/if}
					{#if option.recommended}
						<span class="badge badge-xs badge-primary mt-1 w-fit">Recommended</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}

	{#if question.allowFreeformInput ?? true}
		<fieldset class="fieldset mt-1 p-0">
			<textarea
				class="textarea textarea-bordered min-h-16 w-full resize-y"
				placeholder="Or write your own answer"
				value={isCustomValue ? value : ''}
				onfocus={handleCustomFocus}
				oninput={(event) => updateCustomAnswer((event.currentTarget as HTMLTextAreaElement).value)}
			></textarea>
		</fieldset>
	{/if}
</div>
