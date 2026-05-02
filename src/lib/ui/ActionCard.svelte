<script lang="ts">
	import AskUserQuestionCard from '$lib/chat/AskUserQuestionCard.svelte';

	// ---- ask_user -------------------------------------------------------
	type AskUserOption = {
		label: string;
		description?: string;
		recommended?: boolean;
	};

	type AskUserProps = {
		type: 'ask_user';
		header: string;
		question: {
			header: string;
			question: string;
			options: AskUserOption[];
			allowFreeformInput?: boolean;
		};
		onAnswer: (value: string) => void;
	};

	// ---- tool_approval --------------------------------------------------
	type ToolApprovalProps = {
		type: 'tool_approval';
		header?: string;
		toolName: string;
		toolArgs?: Record<string, unknown>;
		onApprove: () => void;
		onReject: () => void;
	};

	// ---- confirmation ---------------------------------------------------
	type ConfirmationProps = {
		type: 'confirmation';
		header?: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		onConfirm: () => void;
		onCancel: () => void;
	};

	type ActionCardProps = AskUserProps | ToolApprovalProps | ConfirmationProps;

	let props = $props<ActionCardProps>();

	// ask_user local state
	let answerValue = $state('');

	function handleSubmitAnswer() {
		if (props.type === 'ask_user') {
			props.onAnswer(answerValue);
			answerValue = '';
		}
	}

	function argsPreview(args: Record<string, unknown> | undefined): string {
		if (!args) return '';
		try {
			return JSON.stringify(args, null, 2);
		} catch {
			return String(args);
		}
	}
</script>

<div class="rounded-2xl border border-base-300/60 bg-base-100/90 p-4 shadow-sm backdrop-blur-sm">
	<!-- Header row -->
	<div class="mb-3 flex items-center gap-2">
		{#if props.type === 'ask_user'}
			<!-- question icon -->
			<span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15">
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"/>
					<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
				</svg>
			</span>
			<span class="text-sm font-semibold">{props.header}</span>
		{:else if props.type === 'tool_approval'}
			<!-- shield icon -->
			<span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-warning/15">
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
				</svg>
			</span>
			<span class="text-sm font-semibold">{props.header ?? 'Tool approval required'}</span>
		{:else}
			<!-- info icon -->
			<span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-info/15">
				<svg xmlns="http://www.w3.org/2000/svg" class="size-4 text-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
				</svg>
			</span>
			<span class="text-sm font-semibold">{props.header ?? 'Confirm action'}</span>
		{/if}
	</div>

	<!-- Body -->
	{#if props.type === 'ask_user'}
		<p class="mb-3 text-sm text-base-content/80">{props.question.question}</p>
		<AskUserQuestionCard question={props.question} value={answerValue} onChange={(v) => (answerValue = v)} />
		<div class="mt-3 flex justify-end">
			<button
				class="btn btn-primary btn-sm"
				disabled={!answerValue.trim()}
				onclick={handleSubmitAnswer}
			>
				Submit
			</button>
		</div>

	{:else if props.type === 'tool_approval'}
		<p class="mb-2 text-sm text-base-content/80">
			The agent wants to run <code class="rounded bg-base-200 px-1 py-0.5 text-xs font-mono">{props.toolName}</code>
		</p>
		{#if props.toolArgs && Object.keys(props.toolArgs).length > 0}
			<pre class="mb-3 overflow-x-auto rounded-xl border border-base-300/50 bg-base-200/50 p-3 text-xs text-base-content/80">{argsPreview(props.toolArgs)}</pre>
		{/if}
		<div class="flex gap-2">
			<button class="btn btn-error btn-sm flex-1" onclick={props.onReject}>Deny</button>
			<button class="btn btn-success btn-sm flex-1" onclick={props.onApprove}>Allow</button>
		</div>

	{:else}
		<p class="mb-4 text-sm text-base-content/80">{props.message}</p>
		<div class="flex gap-2">
			<button class="btn btn-ghost btn-sm flex-1" onclick={props.onCancel}>
				{props.cancelLabel ?? 'Cancel'}
			</button>
			<button class="btn btn-primary btn-sm flex-1" onclick={props.onConfirm}>
				{props.confirmLabel ?? 'Confirm'}
			</button>
		</div>
	{/if}
</div>
