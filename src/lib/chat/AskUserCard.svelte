<script lang="ts">
	import AskUserQuestionCard from './AskUserQuestionCard.svelte'

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
		questions = [],
		status = 'executing',
		answers = null,
		onSubmit,
	} = $props<{
		questions: AskUserQuestion[]
		status?: 'pending' | 'approved' | 'executing' | 'completed' | 'denied' | 'failed'
		answers?: Record<string, string> | null
		onSubmit?: ((answers: Record<string, string>) => Promise<void> | void) | undefined
	}>()

	let pendingAnswers = $state<Record<string, string>>({})
	let activeIndex = $state(0)
	let submitting = $state(false)

	const totalQuestions = $derived(questions.length)
	const clampedIndex = $derived(
		totalQuestions > 0 ? Math.min(Math.max(activeIndex, 0), totalQuestions - 1) : 0,
	)
	const activeQuestion = $derived<AskUserQuestion | undefined>(questions[clampedIndex])
	const activeHeader = $derived(activeQuestion?.header ?? '')
	const activeAnswered = $derived((pendingAnswers[activeHeader] ?? '').trim().length > 0)

	const hasMissingAnswers = $derived(
		questions.some((q: AskUserQuestion) => (pendingAnswers[q.header] ?? '').trim().length === 0),
	)

	const isAnswered = $derived(status === 'completed' && answers !== null)
	const isWaiting = $derived(!isAnswered && status !== 'failed' && status !== 'denied')

	function setAnswer(header: string, value: string) {
		pendingAnswers = { ...pendingAnswers, [header]: value }
	}

	async function submit() {
		if (hasMissingAnswers || submitting) return
		const payload: Record<string, string> = {}
		for (const q of questions) {
			const v = (pendingAnswers[q.header] ?? '').trim()
			if (v.length > 0) payload[q.header] = v
		}
		if (Object.keys(payload).length === 0) return
		submitting = true
		try {
			await onSubmit?.(payload)
		} finally {
			submitting = false
		}
	}

	function goPrev() {
		if (clampedIndex > 0) activeIndex = clampedIndex - 1
	}
	function goNext() {
		if (clampedIndex < totalQuestions - 1) activeIndex = clampedIndex + 1
	}
</script>

<div class="ask-user-card w-full">
	{#if isAnswered}
		{#each questions as question (question.header)}
			<article class="chat chat-start">
				<div class="chat-bubble assistant-message border-base-300/55 bg-base-100/36 text-base-content border">
					<p class="text-sm font-medium leading-snug">{question.question}</p>
				</div>
			</article>
			{#if (answers?.[question.header] ?? '').trim().length > 0}
				<article class="chat chat-end">
					<div class="chat-bubble chat-bubble-primary user-message border-primary/45 bg-primary/15 text-base-content border">
						<p class="text-sm leading-snug whitespace-pre-wrap">{answers?.[question.header]}</p>
					</div>
				</article>
			{/if}
		{/each}
	{:else if isWaiting}
		<article class="w-full">
			<div class="bg-warning/5 border-warning/40 w-full rounded-2xl border px-4 py-3">
				{#if activeQuestion}
					<div class="mb-3 flex flex-wrap items-start gap-2 text-sm font-medium leading-snug">
						<span class="badge badge-warning badge-sm shrink-0">Question {Math.min(clampedIndex + 1, totalQuestions)}/{totalQuestions || 1}</span>
						<span class="min-w-0 flex-1">{activeQuestion.question}</span>
					</div>

					<AskUserQuestionCard
						question={activeQuestion}
						value={pendingAnswers[activeQuestion.header] ?? ''}
						onChange={(value: string) => setAnswer(activeQuestion.header, value)}
					/>

					<div class="mt-3 flex items-center gap-2">
						<div class="flex items-center gap-1">
							<button
								class="btn btn-ghost btn-xs"
								type="button"
								onclick={goPrev}
								disabled={clampedIndex === 0}
								aria-label="Previous question"
							>
								<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<polyline points="15 18 9 12 15 6" />
								</svg>
							</button>
							<button
								class="btn btn-ghost btn-xs"
								type="button"
								onclick={goNext}
								disabled={clampedIndex >= totalQuestions - 1 || !activeAnswered}
								aria-label="Next question"
							>
								<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<polyline points="9 18 15 12 9 6" />
								</svg>
							</button>
						</div>

						<div class="ml-auto">
							{#if clampedIndex < totalQuestions - 1}
								<button class="btn btn-primary btn-xs" type="button" onclick={goNext} disabled={!activeAnswered}>Next</button>
							{:else}
								<button class="btn btn-primary btn-xs" type="button" onclick={submit} disabled={hasMissingAnswers || submitting}>
									{submitting ? 'Submitting...' : 'Submit'}
								</button>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		</article>
	{:else}
		<article class="chat chat-start">
			<div class="chat-bubble assistant-message border-base-300/55 bg-base-100/36 text-base-content border text-sm opacity-70">
				Question timed out without an answer.
			</div>
		</article>
	{/if}
</div>
