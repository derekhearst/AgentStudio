<script lang="ts">
	import AskUserQuestionCard from './AskUserQuestionCard.svelte'
	import {
		EMPTY_SELECTION,
		answerKey,
		selectionAnswers,
		type AskQuestion,
		type AskSelection,
	} from '$lib/engine/ask-user-question'

	/**
	 * The pending question over the composer, for a page that did not watch it being asked —
	 * a reload, or another tab. Same question card and the same answer keys as the inline
	 * `AskUserCard` (#4); "Type in chat" hands the answer to the composer instead.
	 */
	let {
		open = false,
		questions = [],
		onSubmit,
		onClose,
		onSkipToChat,
	}: {
		open?: boolean
		questions?: AskQuestion[]
		onSubmit?: ((answers: Record<string, string>) => Promise<void> | void) | undefined
		onClose?: (() => void) | undefined
		onSkipToChat?: (() => void) | undefined
	} = $props()

	let collapsed = $state(false)
	let selections = $state<Record<string, AskSelection>>({})
	let activeQuestionIndex = $state(0)

	const totalQuestions = $derived(questions.length)
	const clampedQuestionIndex = $derived(
		totalQuestions > 0 ? Math.min(Math.max(activeQuestionIndex, 0), totalQuestions - 1) : 0,
	)
	const activeQuestion = $derived<AskQuestion | undefined>(questions[clampedQuestionIndex])
	const chosen = $derived(selectionAnswers(questions, selections))
	const activeQuestionHasAnswer = $derived(activeQuestion ? !!chosen[answerKey(activeQuestion)] : false)
	const hasMissingAnswers = $derived(questions.some((question) => !chosen[answerKey(question)]))

	function setSelection(question: AskQuestion, next: AskSelection) {
		selections = { ...selections, [answerKey(question)]: next }
	}

	async function submitAnswers() {
		if (hasMissingAnswers) return
		const payload = selectionAnswers(questions, selections)
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
			<p class="line-clamp-1 min-w-0 text-sm font-semibold">{totalQuestions > 1 ? 'The agent has questions' : 'The agent has a question'}</p>
			<p class="ml-2 shrink-0 text-xs font-medium text-base-content/70">{Math.min(clampedQuestionIndex + 1, totalQuestions)} / {totalQuestions || 1}</p>
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
			<div class="max-h-[60vh] space-y-2 overflow-y-auto px-3 py-3 tablet:max-h-[50vh]">
				{#if activeQuestion}
					{#key answerKey(activeQuestion)}
						<AskUserQuestionCard
							question={activeQuestion}
							selection={selections[answerKey(activeQuestion)] ?? EMPTY_SELECTION}
							onChange={(next) => setSelection(activeQuestion, next)}
						/>
					{/key}
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
