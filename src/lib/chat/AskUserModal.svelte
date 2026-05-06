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
		open = false,
		questions = [],
		onSubmit,
		onClose,
		onSkipToChat,
	} = $props<{
		open?: boolean
		questions?: AskUserQuestion[]
		onSubmit?: ((answers: Record<string, string>) => Promise<void> | void) | undefined
		onClose?: (() => void) | undefined
		onSkipToChat?: (() => void) | undefined
	}>()

	let collapsed = $state(false)
	let answers = $state<Record<string, string>>({})
	let activeQuestionIndex = $state(0)

	const totalQuestions = $derived(questions.length)
	const clampedQuestionIndex = $derived(
		totalQuestions > 0 ? Math.min(Math.max(activeQuestionIndex, 0), totalQuestions - 1) : 0,
	)
	const activeQuestion = $derived(questions[clampedQuestionIndex])
	const activeHeader = $derived(activeQuestion?.header ?? '')
	const activeQuestionHasAnswer = $derived((answers[activeHeader] ?? '').trim().length > 0)

	const hasMissingAnswers = $derived(
		questions.some((question: AskUserQuestion) => (answers[question.header] ?? '').trim().length === 0),
	)

	function setAnswer(header: string, value: string) {
		answers = { ...answers, [header]: value }
	}

	async function submitAnswers() {
		if (hasMissingAnswers) return
		const payload: Record<string, string> = {}
		for (const question of questions) {
			const value = (answers[question.header] ?? '').trim()
			if (value.length > 0) {
				payload[question.header] = value
			}
		}
		if (Object.keys(payload).length === 0) return
		await onSubmit?.(payload)
	}

	function closeOnly() {
		activeQuestionIndex = 0
		onClose?.()
	}

	function skipToChat() {
		activeQuestionIndex = 0
		onSkipToChat?.()
	}

	function goToPreviousQuestion() {
		if (clampedQuestionIndex <= 0) return
		activeQuestionIndex = clampedQuestionIndex - 1
	}

	function goToNextQuestion() {
		if (clampedQuestionIndex >= questions.length - 1) return
		activeQuestionIndex = clampedQuestionIndex + 1
	}
</script>

{#if open}
	<div class="card border-base-300 bg-base-200/95 relative mb-2 rounded-2xl border shadow-xl">
		<header class="border-base-300 flex items-center gap-2 border-b px-3 py-2.5">
			<p class="line-clamp-1 text-sm font-semibold">{activeQuestion?.question ?? 'Question'}</p>
			<p class="ml-2 text-xs font-medium text-base-content/70">{Math.min(clampedQuestionIndex + 1, totalQuestions)} / {totalQuestions || 1}</p>
			<div class="ml-auto flex items-center gap-1">
				<button class="btn btn-ghost btn-xs" type="button" aria-label="Collapse" onclick={() => (collapsed = !collapsed)}>
					<svg class={`h-4 w-4 transition-transform ${collapsed ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</button>
				<button class="btn btn-ghost btn-xs" type="button" aria-label="Close" onclick={closeOnly}>
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</div>
		</header>

		{#if !collapsed}
			<div class="max-h-[38vh] space-y-2 overflow-y-auto px-3 py-3">
				{#if activeQuestion}
					<AskUserQuestionCard
						question={activeQuestion}
						value={answers[activeQuestion.header] ?? ''}
						onChange={(value) => setAnswer(activeQuestion.header, value)}
					/>
				{/if}
			</div>

			<footer class="card-actions border-base-300 bg-base-100/60 flex items-center gap-2 border-t px-3 py-2.5">
				<div class="flex items-center gap-1">
					<button
						class="btn btn-ghost btn-xs"
						type="button"
						onclick={goToPreviousQuestion}
						disabled={clampedQuestionIndex === 0}
						aria-label="Previous question"
					>
						<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="15 18 9 12 15 6" />
						</svg>
					</button>
					<button
						class="btn btn-ghost btn-xs"
						type="button"
						onclick={goToNextQuestion}
						disabled={clampedQuestionIndex >= totalQuestions - 1}
						aria-label="Next question"
					>
						<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="9 18 15 12 9 6" />
						</svg>
					</button>
				</div>

				<div class="ml-auto flex items-center gap-2">
					<button class="btn btn-ghost btn-xs" type="button" onclick={skipToChat}>Type in chat</button>
					{#if clampedQuestionIndex < totalQuestions - 1}
						<button class="btn btn-primary btn-xs" type="button" onclick={goToNextQuestion} disabled={!activeQuestionHasAnswer}>Next</button>
					{:else}
						<button class="btn btn-primary btn-xs" type="button" onclick={submitAnswers} disabled={hasMissingAnswers}>Submit</button>
					{/if}
				</div>
			</footer>
		{/if}
	</div>
{/if}
