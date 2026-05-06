<script lang="ts">
	import ToolCallCard from './ToolCallCard.svelte';
	import ThinkingBlockCard from './ThinkingBlockCard.svelte';
	import SubagentBlockCard from './SubagentBlockCard.svelte';
	import PlanProposalCard from './PlanProposalCard.svelte';
	import { renderMarkdown } from '$lib/chat/chat';

	type MessageRow = {
		id: string;
		role: 'user' | 'assistant' | 'system' | 'tool';
		content: string;
		model: string | null;
		tokensIn: number;
		tokensOut: number;
		cost: string;
		ttftMs: number | null;
		totalMs: number | null;
		tokensPerSec: number | null;
		createdAt: Date | string;
		toolCalls?: Array<Record<string, unknown>>;
		metadata?: Record<string, unknown> | null;
	};

	type SavedBlock =
		| { kind: 'text'; content: string }
		| { kind: 'thinking'; content: string; reasoningTokens?: number | null }
		| {
				kind: 'tool';
				name: string;
				arguments: unknown;
				result: unknown;
				success: boolean;
				executionMs: number;
		  }
		| {
				kind: 'subagent';
				agentId: string;
				agentName: string;
				conversationId: string | null;
				task: string;
				content: string;
				success: boolean;
		  };

	let {
		message,
		onEdit,
		onRegenerate,
	} = $props<{
		message: MessageRow;
		onEdit?: ((messageId: string, content: string) => Promise<void> | void) | undefined;
		onRegenerate?: ((messageId: string) => Promise<void> | void) | undefined;
	}>();

	let editing = $state(false);
	let editingBusy = $state(false);
	let copied = $state(false);
	let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;
	let draft = $state('');
	let editorRoot = $state<HTMLDivElement | null>(null);

	const isUser = $derived(message.role === 'user');
	const isAssistant = $derived(message.role === 'assistant');
	const renderedAssistantMarkdown = $derived(isAssistant ? renderMarkdown(message.content ?? '') : '');
	const estimatedTokensOut = $derived(
		message.tokensOut > 0 ? message.tokensOut : Math.max(1, Math.ceil((message.content?.length ?? 0) / 4))
	);
	const estimatedTokensIn = $derived(
		message.tokensIn > 0 ? message.tokensIn : Math.max(1, Math.ceil((message.content?.length ?? 0) / 4))
	);
	const formattedCost = $derived(Number.parseFloat(message.cost || '0').toFixed(4));
	const messageReasoningTokens = $derived.by(() => {
		const value = (message.metadata as Record<string, unknown> | null | undefined)?.reasoningTokens;
		return typeof value === 'number' && value > 0 ? value : null;
	});

	function asRecord(value: unknown): Record<string, unknown> | null {
		if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
		if (typeof value !== 'string') return null;
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}

	function asArray(value: unknown): unknown[] {
		if (Array.isArray(value)) return value;
		if (typeof value !== 'string') return [];
		try {
			const parsed = JSON.parse(value) as unknown;
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	const savedBlocks = $derived.by(() => {
		const metadata = asRecord(message.metadata) ?? ((message.metadata as Record<string, unknown> | null | undefined) ?? null);
		const blocks = metadata?.blocks;
		return Array.isArray(blocks) ? (blocks as SavedBlock[]) : null;
	});

	function blockHasRenderableOutput(block: SavedBlock): boolean {
		if (block.kind === 'text' || block.kind === 'thinking') return !!block.content?.trim()
		if (block.kind === 'tool') return !!block.name
		if (block.kind === 'subagent') return !!(block.agentName?.trim() || block.task?.trim() || block.content?.trim())
		return false
	}

	type NormalizedToolCall = {
		name?: string | null;
		arguments?: unknown;
		result?: unknown;
		success?: boolean | null;
	};
	const normalizedToolCalls = $derived.by(() => asArray(message.toolCalls) as NormalizedToolCall[]);

	// Suppress empty assistant articles (interrupted streams, automation runs with no body).
	// User + system messages always render via a different branch in the template.
	const hasRenderableContent = $derived.by(() => {
		if (message.role !== 'assistant') return true
		if (savedBlocks && savedBlocks.length > 0) {
			return savedBlocks.some(blockHasRenderableOutput)
		}
		if (normalizedToolCalls.length > 0) return true
		return !!message.content?.trim()
	});

	function getAskUserQuestions(argumentsValue: unknown, resultValue: unknown): Array<{ header: string; question?: string }> {
		const args = asRecord(argumentsValue);
		const result = asRecord(resultValue);
		const fromArgs = Array.isArray(args?.questions) ? args.questions : [];
		const fromResult = Array.isArray(result?.questions) ? result.questions : [];
		const source = fromArgs.length > 0 ? fromArgs : fromResult;

		return source
			.map((q) => {
				const row = asRecord(q);
				const header = typeof row?.header === 'string' ? row.header : '';
				const question = typeof row?.question === 'string' ? row.question : undefined;
				return { header, question };
			})
			.filter((q) => q.header.length > 0 || (q.question?.length ?? 0) > 0);
	}

	function getAskUserAnswer(resultValue: unknown, header: string): string | null {
		const result = asRecord(resultValue);
		const answers = asRecord(result?.answers);
		if (!answers) return null;
		const value = answers[header];
		if (typeof value !== 'string') return null;
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	type PlanStep = {
		title: string;
		detail?: string;
		estimatedDurationMin?: number;
		estimatedCostUsd?: number;
		blastRadius?: 'local' | 'shared' | 'production';
		reversible?: boolean;
	};
	type PlanProposal = {
		summary: string;
		steps: PlanStep[];
		risks?: string[];
		rollback?: string;
		totalEstimatedCostUsd?: number;
		totalEstimatedDurationMin?: number;
	};

	function getPlanProposal(argumentsValue: unknown): PlanProposal | null {
		const args = asRecord(argumentsValue);
		if (!args) return null;
		if (typeof args.summary !== 'string' || !Array.isArray(args.steps)) return null;
		const steps: PlanStep[] = (args.steps as Array<unknown>)
			.map((raw) => {
				const s = asRecord(raw);
				if (!s || typeof s.title !== 'string') return null;
				const step: PlanStep = { title: s.title };
				if (typeof s.detail === 'string') step.detail = s.detail;
				if (typeof s.estimatedDurationMin === 'number') step.estimatedDurationMin = s.estimatedDurationMin;
				if (typeof s.estimatedCostUsd === 'number') step.estimatedCostUsd = s.estimatedCostUsd;
				if (s.blastRadius === 'local' || s.blastRadius === 'shared' || s.blastRadius === 'production') {
					step.blastRadius = s.blastRadius;
				}
				if (typeof s.reversible === 'boolean') step.reversible = s.reversible;
				return step;
			})
			.filter((s): s is PlanStep => s !== null);
		if (steps.length === 0) return null;
		const plan: PlanProposal = { summary: args.summary, steps };
		if (Array.isArray(args.risks)) plan.risks = args.risks.filter((r): r is string => typeof r === 'string');
		if (typeof args.rollback === 'string') plan.rollback = args.rollback;
		if (typeof args.totalEstimatedCostUsd === 'number') plan.totalEstimatedCostUsd = args.totalEstimatedCostUsd;
		if (typeof args.totalEstimatedDurationMin === 'number') plan.totalEstimatedDurationMin = args.totalEstimatedDurationMin;
		return plan;
	}

	function normalizeText(value: string): string {
		return value.toLowerCase().replace(/\s+/g, ' ').trim();
	}

	function askQuestionAlreadyInMessage(question: string | undefined, blocks: SavedBlock[] | null): boolean {
		const q = normalizeText(question ?? '');
		if (!q) return false;

		if (blocks) {
			for (const block of blocks) {
				if (block.kind !== 'text') continue;
				const text = normalizeText(block.content ?? '');
				if (text.includes(q)) return true;
			}
		}

		const messageText = normalizeText(message.content ?? '');
		return messageText.includes(q);
	}
	const lastThinkingBlockIndex = $derived(
		savedBlocks
			? savedBlocks.reduce((latest, block, index) => (block.kind === 'thinking' ? index : latest), -1)
			: -1
	);

	$effect(() => {
		if (!editing) return;

		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (editorRoot && target instanceof Node && !editorRoot.contains(target)) {
				cancelEditing();
			}
		};

		const onEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				cancelEditing();
			}
		};

		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('keydown', onEscape);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('keydown', onEscape);
		};
	});

	function startEditing() {
		draft = message.content;
		editing = true;
		editingBusy = false;
	}

	function cancelEditing() {
		editing = false;
		editingBusy = false;
		draft = message.content;
	}

	async function submitEdit() {
		const trimmed = draft.trim();
		if (!trimmed || editingBusy) return;
		editingBusy = true;
		try {
			await onEdit?.(message.id, trimmed);
			editing = false;
		} finally {
			editingBusy = false;
		}
	}

	function handleEditorKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void submitEdit();
		}
	}

	async function copyAssistantResponse() {
		if (!isAssistant || !message.content?.trim()) return;
		try {
			if (navigator?.clipboard?.writeText) {
				await navigator.clipboard.writeText(message.content);
			} else {
				const textarea = document.createElement('textarea');
				textarea.value = message.content;
				textarea.setAttribute('readonly', '');
				textarea.style.position = 'absolute';
				textarea.style.left = '-9999px';
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand('copy');
				document.body.removeChild(textarea);
			}
			copied = true;
			if (copiedResetTimer) clearTimeout(copiedResetTimer);
			copiedResetTimer = setTimeout(() => {
				copied = false;
				copiedResetTimer = null;
			}, 1200);
		} catch {
			copied = false;
		}
	}
</script>

{#if hasRenderableContent}
<article class={`chat-message w-full ${isUser ? 'chat chat-end' : 'flex flex-col'}`}>
	{#if isUser}
		{#if editing}
			<div bind:this={editorRoot} class="card bg-base-100 border-base-300 max-w-[90%] border p-2 shadow-sm sm:p-3">
				<textarea
					class="textarea textarea-ghost w-full resize-none px-1.5 py-1 text-base leading-6 focus:outline-none"
					rows="3"
					bind:value={draft}
					onkeydown={handleEditorKeydown}
					disabled={editingBusy}
				></textarea>
				<div class="mt-2 flex items-center justify-end gap-2 px-1">
					<button class="btn btn-ghost btn-sm" type="button" onclick={cancelEditing} disabled={editingBusy}>
						Cancel
					</button>
					<button class="btn btn-primary btn-sm" type="button" onclick={submitEdit} disabled={!draft.trim() || editingBusy}>
						{editingBusy ? 'Updating…' : 'Save & regenerate'}
					</button>
				</div>
			</div>
		{:else}
			<div class="user-bubble bg-base-200/80 text-base-content max-w-[85%] rounded-2xl px-4 py-2.5 shadow-sm">
				<p class="whitespace-pre-wrap">{message.content}</p>
			</div>
		{/if}
	{:else if savedBlocks}
		{#each savedBlocks as block, idx (`${message.id}-block-${idx}`)}
			{#if block.kind === 'tool' && block.name === 'ask_user'}
				{@const askQuestions = getAskUserQuestions(block.arguments, block.result)}
				{#if askQuestions.length > 0}
					{#each askQuestions as q}
						{#if !askQuestionAlreadyInMessage(q.question ?? q.header, savedBlocks)}
							<div class="assistant-message mb-2">
								<div class="markdown-body">{@html renderMarkdown(q.question ?? q.header)}</div>
							</div>
						{/if}
						{@const answer = getAskUserAnswer(block.result, q.header)}
						{#if answer}
							<div class="mb-2 ml-auto w-fit max-w-[85%]">
								<div class="user-bubble bg-base-200/80 text-base-content rounded-2xl px-4 py-2.5 shadow-sm">
									<p class="whitespace-pre-wrap">{answer}</p>
								</div>
							</div>
						{/if}
					{/each}
				{/if}
			{:else if block.kind === 'tool' && block.name === 'propose_plan'}
				{@const plan = getPlanProposal(block.arguments)}
				{#if plan}
					<div class="mb-1.5 w-full">
						<PlanProposalCard {plan} status={block.success === false ? 'denied' : 'completed'} />
					</div>
				{:else}
					<div class="mb-1.5 w-full">
						<ToolCallCard
							name={String(block.name)}
							argumentsText={JSON.stringify(block.arguments ?? {}, null, 2)}
							result={typeof block.result === 'string' ? block.result : JSON.stringify(block.result ?? {}, null, 2)}
							status={block.success === false ? 'failed' : 'completed'}
						/>
					</div>
				{/if}
			{:else if block.kind === 'tool' && block.name !== 'ask_user'}
				<div class="mb-1.5 w-full">
					<ToolCallCard
						name={String(block.name)}
						argumentsText={JSON.stringify(block.arguments ?? {}, null, 2)}
						result={typeof block.result === 'string' ? block.result : JSON.stringify(block.result ?? {}, null, 2)}
						status={block.success === false ? 'failed' : 'completed'}
					/>
				</div>
			{:else if block.kind === 'thinking' && block.content?.trim()}
				<div class="mb-1.5 w-full">
					<ThinkingBlockCard
						content={block.content}
						reasoningTokens={idx === lastThinkingBlockIndex ? messageReasoningTokens : block.reasoningTokens ?? null}
						expanded={true}
					/>
				</div>
			{:else if block.kind === 'subagent' && blockHasRenderableOutput(block)}
				<div class="mb-1.5 w-full">
					<SubagentBlockCard
						agentName={block.agentName}
						agentId={block.agentId}
						conversationId={block.conversationId}
						task={block.task}
						content={block.content}
						status={block.success ? 'completed' : 'failed'}
						expanded={false}
					/>
				</div>
			{:else if block.kind === 'text' && block.content?.trim()}
				<div class="assistant-message mb-2">
					<div class="markdown-body">{@html renderMarkdown(block.content)}</div>
				</div>
			{/if}
		{/each}
	{:else}
		{#if normalizedToolCalls.length > 0}
			<div class="mb-2 w-full space-y-2">
				{#each normalizedToolCalls as call, idx (`${message.id}-${idx}`)}
				{#if call.name === 'ask_user'}
					{@const askQuestions = getAskUserQuestions(call.arguments, call.result)}
					{#if askQuestions.length > 0}
						{#each askQuestions as q}
							{#if !askQuestionAlreadyInMessage(q.question ?? q.header, savedBlocks)}
								<div class="assistant-message mb-2">
									<div class="markdown-body">{@html renderMarkdown(q.question ?? q.header)}</div>
								</div>
							{/if}
							{@const answer = getAskUserAnswer(call.result, q.header)}
							{#if answer}
								<div class="mb-2 ml-auto w-fit max-w-[85%]">
									<div class="user-bubble bg-base-200/80 text-base-content rounded-2xl px-4 py-2.5 shadow-sm">
										<p class="whitespace-pre-wrap">{answer}</p>
									</div>
								</div>
							{/if}
						{/each}
					{/if}
				{:else if call.name === 'propose_plan'}
					{@const plan = getPlanProposal(call.arguments)}
					{#if plan}
						<PlanProposalCard {plan} status="completed" />
					{:else}
						<ToolCallCard
							name="propose_plan"
							argumentsText={JSON.stringify(call.arguments ?? {}, null, 2)}
							result={typeof call.result === 'string' ? call.result : JSON.stringify(call.result ?? {}, null, 2)}
						/>
					{/if}
				{:else}
					<ToolCallCard
						name={String(call.name ?? 'tool')}
						argumentsText={JSON.stringify(call.arguments ?? {}, null, 2)}
						result={typeof call.result === 'string' ? call.result : JSON.stringify(call.result ?? {}, null, 2)}
					/>
				{/if}
			{/each}
			</div>
		{/if}
		{#if message.content?.trim()}
			<div class="assistant-message">
				<div class="markdown-body">{@html renderedAssistantMarkdown}</div>
			</div>
		{/if}
	{/if}

	{#if !editing}
		<div class={`chat-footer mt-1 flex items-center gap-1 ${isUser ? 'justify-end' : 'justify-start'}`} style={isUser ? 'grid-column: 1 / -1; justify-self: end;' : 'grid-column: 1 / -1; justify-self: start;'}>
			{#if isUser}
				<button class="btn btn-ghost btn-xs btn-circle" type="button" onclick={startEditing} title="Edit message" aria-label="Edit message">
					<i class="mdi mdi-pencil-outline text-sm" aria-hidden="true"></i>
				</button>
			{/if}
			{#if isAssistant}
				<button
					class="btn btn-ghost btn-xs rounded-md px-2"
					type="button"
					onclick={copyAssistantResponse}
					title="Copy response"
					aria-label="Copy response"
				>
					{#if copied}
						<i class="mdi mdi-check text-sm text-success" aria-hidden="true"></i>
					{:else}
						<i class="mdi mdi-content-copy text-sm" aria-hidden="true"></i>
					{/if}
				</button>
				<button class="btn btn-ghost btn-xs rounded-md px-2" type="button" onclick={() => onRegenerate?.(message.id)} title="Regenerate response" aria-label="Regenerate response">
					<i class="mdi mdi-refresh text-sm" aria-hidden="true"></i>
				</button>
				<div class="dropdown dropdown-top">
					<button tabindex="0" class="btn btn-ghost btn-xs btn-circle" type="button" title="Message stats" aria-label="Message stats">
						<i class="mdi mdi-information-outline text-sm" aria-hidden="true"></i>
					</button>
					<div tabindex="0" role="menu" class="dropdown-content card card-compact bg-base-100 border-base-300 z-20 mt-2 w-72 border p-3 text-xs shadow-xl">
						<div class="grid grid-cols-2 gap-x-3 gap-y-2">
							<span class="opacity-70">Model</span>
							<span class="truncate text-right">{message.model ?? 'n/a'}</span>
							<span class="opacity-70">Tokens In</span>
							<span class="text-right">{estimatedTokensIn}</span>
							<span class="opacity-70">Tokens Out</span>
							<span class="text-right">{estimatedTokensOut}</span>
							{#if messageReasoningTokens !== null}
								<span class="opacity-70">Thinking</span>
								<span class="text-right">{messageReasoningTokens.toLocaleString()}</span>
							{/if}
							<span class="opacity-70">Cost</span>
							<span class="text-right">${formattedCost}</span>
							<span class="opacity-70">TTFT</span>
							<span class="text-right">{message.ttftMs ?? 'n/a'}{message.ttftMs !== null ? 'ms' : ''}</span>
							<span class="opacity-70">Total</span>
							<span class="text-right">{message.totalMs ?? 'n/a'}{message.totalMs !== null ? 'ms' : ''}</span>
							<span class="opacity-70">Tok/s</span>
							<span class="text-right">{message.tokensPerSec ?? 'n/a'}</span>
						</div>
					</div>
				</div>
			{/if}
		</div>
	{/if}

</article>
{/if}
