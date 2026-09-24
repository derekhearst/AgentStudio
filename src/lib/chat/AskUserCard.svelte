<script lang="ts">
	import AskUserQuestionCard from './AskUserQuestionCard.svelte';
	import {
		EMPTY_SELECTION,
		answerKey,
		selectionAnswers,
		type AskQuestion,
		type AskSelection,
	} from '$lib/engine/ask-user-question';

	/**
	 * The agent's questions, inline in the chat and in the /review inbox (#4).
	 *
	 * Waiting: one question at a time (`AskUserQuestionCard`), with a counter and Next/Submit
	 * when there are several. Answered: each question with its answer under it, the way the
	 * saved transcript shows it after a reload.
	 *
	 * Answers are keyed by each question's `answerKey` — its text for the SDK's
	 * AskUserQuestion, its header for a question from the retired `ask_user` — which is what
	 * the answer endpoints record and what the engine hands back to the SDK.
	 */
	let {
		questions = [],
		status = 'executing',
		answers = null,
		onSubmit,
	}: {
		questions: AskQuestion[];
		status?: 'pending' | 'approved' | 'executing' | 'completed' | 'denied' | 'failed';
		answers?: Record<string, string> | null;
		onSubmit?: ((answers: Record<string, string>) => Promise<void> | void) | undefined;
	} = $props();

	let selections = $state<Record<string, AskSelection>>({});
	let activeIndex = $state(0);
	let submitting = $state(false);

	const totalQuestions = $derived(questions.length);
	const clampedIndex = $derived(totalQuestions > 0 ? Math.min(Math.max(activeIndex, 0), totalQuestions - 1) : 0);
	const activeQuestion = $derived<AskQuestion | undefined>(questions[clampedIndex]);
	const chosen = $derived(selectionAnswers(questions, selections));
	const activeAnswered = $derived(activeQuestion ? !!chosen[answerKey(activeQuestion)] : false);
	const hasMissingAnswers = $derived(questions.some((q) => !chosen[answerKey(q)]));

	const isAnswered = $derived(status === 'completed' && answers !== null);
	const isWaiting = $derived(!isAnswered && status !== 'failed' && status !== 'denied');

	function answerFor(question: AskQuestion): string {
		return (answers?.[answerKey(question)] ?? answers?.[question.header] ?? '').trim();
	}

	function setSelection(question: AskQuestion, next: AskSelection) {
		selections = { ...selections, [answerKey(question)]: next };
	}

	async function submit() {
		if (hasMissingAnswers || submitting) return;
		const payload = selectionAnswers(questions, selections);
		if (Object.keys(payload).length === 0) return;
		submitting = true;
		try {
			await onSubmit?.(payload);
		} finally {
			submitting = false;
		}
	}

	function goPrev() {
		if (clampedIndex > 0) activeIndex = clampedIndex - 1;
	}
	function goNext() {
		if (clampedIndex < totalQuestions - 1) activeIndex = clampedIndex + 1;
	}
</script>

<div class="ask-user-card w-full min-w-0">
	{#if isAnswered}
		{#each questions as question (answerKey(question))}
			<div class="assistant-message mb-2">
				<p class="text-sm leading-snug font-medium">{question.question}</p>
			</div>
			{#if answerFor(question)}
				<div class="mb-2 ml-auto w-fit max-w-[85%]">
					<div class="user-bubble bg-base-200/80 text-base-content rounded-2xl px-4 py-2.5 shadow-sm">
						<p class="text-sm leading-snug whitespace-pre-wrap">{answerFor(question)}</p>
					</div>
				</div>
			{/if}
		{/each}
	{:else if isWaiting}
		<article class="w-full min-w-0">
			<div class="bg-warning/5 border-warning/40 w-full min-w-0 rounded-2xl border px-3 py-3 tablet:px-4">
				{#if activeQuestion}
					{#if totalQuestions > 1}
						<div class="mb-2 flex items-center gap-2">
							<span class="badge badge-warning badge-sm shrink-0">Question {clampedIndex + 1}/{totalQuestions}</span>
						</div>
					{/if}

					{#key answerKey(activeQuestion)}
						<AskUserQuestionCard
							question={activeQuestion}
							selection={selections[answerKey(activeQuestion)] ?? EMPTY_SELECTION}
							onChange={(next) => setSelection(activeQuestion, next)}
							disabled={submitting}
						/>
					{/key}

					<div class="mt-3 flex items-center gap-2">
						{#if totalQuestions > 1}
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
						{/if}

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
		<div class="assistant-message text-sm opacity-70">Question timed out without an answer.</div>
	{/if}
</div>
