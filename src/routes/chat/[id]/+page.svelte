<svelte:head><title>{conversationData?.conversation.title ?? 'Chat'} | DrokBot</title></svelte:head>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import {
		editMessage,
		getConversation,
		getMessageStats
	} from '$lib/chat';
	import { getAvailableModels } from '$lib/llm';
	import { getSettings } from '$lib/settings';
	import { getArtifact, getArtifactsByConversation, pinArtifact as pinArtifactCommand } from '$lib/artifacts';
	import ChatInput from '$lib/components/chat/ChatInput.svelte';
	import ContextWindow from '$lib/components/chat/ContextWindow.svelte';
	import MessageBubble from '$lib/components/chat/MessageBubble.svelte';
	import LiveToolCallCard from '$lib/components/chat/LiveToolCallCard.svelte';
	import { renderMarkdown } from '$lib/chat/markdown';
	import ArtifactPanel from '$lib/components/artifacts/ArtifactPanel.svelte';

	type ChatAttachment = {
		id: string;
		filename: string;
		mimeType: string;
		size: number;
		url: string;
	};

	type StreamingToolCall = {
		id: string;
		name: string;
		arguments: string;
		status: 'pending' | 'approved' | 'executing' | 'completed' | 'denied';
		result?: string;
		executionMs?: number | null;
		expanded: boolean;
		token?: string | null;
	};

	const conversationId = $derived(page.params.id ?? '');
	let model = $state('anthropic/claude-sonnet-4');
	let streaming = $state(false);
	let streamError = $state<string | null>(null);
	let draftAssistant = $state('');
	let pendingMessageId = $state<string | null>(null);
	let pendingUserMessages = $state<Array<{ id: string; content: string; createdAt: Date }>>([]);
	let pendingAssistantDrafts = $state<Array<{ id: string; content: string; createdAt: Date; toolCalls?: Array<Record<string, unknown>> }>>([]);
	let waitingForFirstToken = $state(false);
	let streamAbortController = $state<AbortController | null>(null);
	let stoppedByUser = $state(false);
	let streamingToolCalls = $state<StreamingToolCall[]>([]);
	let conversationData = $state<Awaited<ReturnType<typeof getConversation>> | null>(null);
	let stats = $state<Awaited<ReturnType<typeof getMessageStats>>>([]);
	let availableModels = $derived(await getAvailableModels());
	let appSettings = $derived(await getSettings());
	let messagesEl = $state<HTMLDivElement | undefined>(undefined);
	let consumedInitialPrompt = $state(false);
	let modelSwitchNotice = $state<string | null>(null);
	let defaultModelApplied = $state(false);
	let streamedAssistantTarget = $state('');
	let draftInterpolationFrame = $state<number | null>(null);
	let draftInterpolationLastTs = $state<number | null>(null);

	// Artifact panel state
	type PanelMode = 'collapsed' | 'panel' | 'fullscreen';
	let activeArtifact = $state<Awaited<ReturnType<typeof getArtifact>> | null>(null);
	let artifactPanelMode = $state<PanelMode>('collapsed');
	let conversationArtifacts = $state<Awaited<ReturnType<typeof getArtifactsByConversation>>>([]);

	async function openArtifact(artifactId: string) {
		const result = await getArtifact(artifactId);
		if (result) {
			activeArtifact = result;
			artifactPanelMode = 'panel';
		}
	}

	function closeArtifactPanel() {
		activeArtifact = null;
		artifactPanelMode = 'collapsed';
	}

	async function handlePinArtifact(id: string, pinned: boolean) {
		await pinArtifactCommand({ id, pinned });
		if (activeArtifact && activeArtifact.id === id) {
			activeArtifact = { ...activeArtifact, pinned };
		}
	}

	async function loadConversationArtifacts() {
		if (!conversationId) {
			conversationArtifacts = [];
			return;
		}
		conversationArtifacts = await getArtifactsByConversation(conversationId);
	}

	async function scrollToBottom() {
		await tick();
		if (messagesEl) {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		}
	}

	function stopDraftInterpolation() {
		if (draftInterpolationFrame !== null) {
			cancelAnimationFrame(draftInterpolationFrame);
			draftInterpolationFrame = null;
		}
		draftInterpolationLastTs = null;
	}

	function interpolateDraft(now: number) {
		draftInterpolationFrame = null;
		if (draftInterpolationLastTs === null) {
			draftInterpolationLastTs = now;
		}

		const elapsedMs = now - draftInterpolationLastTs;
		draftInterpolationLastTs = now;
		const remaining = streamedAssistantTarget.length - draftAssistant.length;
		if (remaining <= 0) {
			stopDraftInterpolation();
			return;
		}

		const charsPerSecond = Math.min(280, Math.max(80, remaining * 4));
		const step = Math.max(1, Math.floor((charsPerSecond * Math.max(16, elapsedMs)) / 1000));
		draftAssistant += streamedAssistantTarget.slice(draftAssistant.length, draftAssistant.length + step);

		if (draftAssistant.length < streamedAssistantTarget.length) {
			draftInterpolationFrame = requestAnimationFrame(interpolateDraft);
		} else {
			stopDraftInterpolation();
		}
	}

	function queueDraftInterpolation() {
		if (draftAssistant.length >= streamedAssistantTarget.length) return;
		if (draftInterpolationFrame !== null) return;
		draftInterpolationFrame = requestAnimationFrame(interpolateDraft);
	}

	$effect(() => {
		// Auto-scroll when messages change or during streaming
		void messages.length;
		void draftAssistant;
		void streamingToolCalls.map((tc) => `${tc.id}:${tc.status}:${tc.expanded}:${tc.result?.length ?? 0}`).join('|');
		scrollToBottom();
	});

	$effect(() => {
		return () => {
			stopDraftInterpolation();
		};
	});

	$effect(() => {
		void loadConversationState();
	});

	const messages = $derived(conversationData?.messages ?? []);
	const initialPrompt = $derived(page.url.searchParams.get('prompt')?.trim() ?? '');
	const estimateTokens = (value: string | null | undefined) =>
		Math.max(0, Math.ceil((value?.length ?? 0) / 4));
	const displayedMessages = $derived.by(() => {
		const remoteMessages = messages;
		const remoteIds = new Set(remoteMessages.map((message) => message.id));

		const optimisticUsers = pendingUserMessages
			.filter((message) =>
				!remoteMessages.some(
					(remote) =>
						remote.role === 'user' &&
						remote.content === message.content &&
						new Date(remote.createdAt).getTime() >= message.createdAt.getTime() - 15000
				)
			)
			.map((message) => ({
				id: message.id,
				role: 'user' as const,
				content: message.content,
				model,
				tokensIn: 0,
				tokensOut: 0,
				cost: '0',
				ttftMs: null,
				totalMs: null,
				tokensPerSec: null,
				createdAt: message.createdAt,
				toolCalls: []
			}));

		const pendingAssistants = pendingAssistantDrafts
			.filter((message) => !remoteIds.has(message.id))
			.map((message) => ({
				id: message.id,
				role: 'assistant' as const,
				content: message.content,
				model,
				tokensIn: 0,
				tokensOut: 0,
				cost: '0',
				ttftMs: null,
				totalMs: null,
				tokensPerSec: null,
				createdAt: message.createdAt,
				toolCalls: message.toolCalls ?? []
			}));

		const combined = [...remoteMessages, ...optimisticUsers, ...pendingAssistants];
		combined.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
		return combined;
	});

	const activeContextLimit = $derived.by(() => {
		const selected = availableModels.find((candidate) => candidate.id === model);
		return selected?.contextLength && selected.contextLength > 0 ? selected.contextLength : 128000;
	});
	const reservedResponsePct = $derived(appSettings?.contextConfig?.reservedResponsePct ?? 30);
	const autoCompactThresholdPct = $derived(appSettings?.contextConfig?.autoCompactThresholdPct ?? 72);

	const contextMetrics = $derived.by(() => {
		const totalBudget = activeContextLimit;

		const messageTokens = displayedMessages.reduce(
			(sum, message) => sum + estimateTokens(message.content),
			0
		);

		const toolResultTokens = displayedMessages.reduce((sum, message) => {
			const calls = message.toolCalls ?? [];
			for (const call of calls) {
				const resultText =
					typeof call.result === 'string' ? call.result : JSON.stringify(call.result ?? {});
				sum += estimateTokens(resultText);
			}
			return sum;
		}, 0);

		const systemTokens = 900;
		const toolDefinitionTokens = 900;
		const otherTokens = 0;

		const used = Math.min(
			totalBudget,
			systemTokens + toolDefinitionTokens + messageTokens + toolResultTokens + otherTokens
		);

		const toPct = (value: number) =>
			totalBudget > 0 ? Math.max(0, Number(((value / totalBudget) * 100).toFixed(1))) : 0;

		const modelTokenMap = new Map<string, number>();
		for (const row of stats) {
			if (row.role !== 'assistant') continue;
			const modelLabel = (row.model ?? 'unknown').split('/').at(-1) ?? row.model ?? 'unknown';
			const modelTokens = row.tokensOut > 0 ? row.tokensOut : estimateTokens(messages.find((m) => m.id === row.id)?.content);
			modelTokenMap.set(modelLabel, (modelTokenMap.get(modelLabel) ?? 0) + modelTokens);
		}

		const modelTotal = [...modelTokenMap.values()].reduce((sum, value) => sum + value, 0);
		const modelPalette = ['var(--color-primary)', 'var(--color-secondary)', 'var(--color-accent)', 'var(--color-info)'];
		const modelUsage = [...modelTokenMap.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([label, value], idx) => ({
				label,
				value: modelTotal > 0 ? Number(((value / modelTotal) * 100).toFixed(1)) : 0,
				color: modelPalette[idx % modelPalette.length]
			}));

		return {
			total: totalBudget,
			used,
			breakdown: {
				system: toPct(systemTokens),
				tools: toPct(toolDefinitionTokens),
				messages: toPct(messageTokens),
				results: toPct(toolResultTokens),
				other: toPct(otherTokens)
			},
			modelUsage
		};
	});

	$effect(() => {
		if (conversationData?.conversation.model) {
			model = conversationData.conversation.model;
		}
	});

	$effect(() => {
		if (defaultModelApplied || conversationData?.conversation.model) return;
		if (appSettings?.defaultModel) {
			model = appSettings.defaultModel;
			defaultModelApplied = true;
		}
	});

	$effect(() => {
		const prompt = initialPrompt;
		if (!prompt || consumedInitialPrompt || !conversationId || streaming) return;
		if (messages.length > 0 || pendingUserMessages.length > 0) {
			consumedInitialPrompt = true;
			return;
		}

		consumedInitialPrompt = true;
		void streamMessage(prompt, false).finally(() => {
			void goto(`/chat/${conversationId}`, {
				replaceState: true,
				noScroll: true,
				keepFocus: true
			});
		});
	});

	$effect(() => {
		void displayedMessages.length;
		if (!pendingMessageId) return;
		if (messages.some((message) => message.id === pendingMessageId)) {
			draftAssistant = '';
			pendingMessageId = null;
		}
	});

	function reconcilePendingWithRemote(remoteMessages: typeof messages) {
		pendingAssistantDrafts = pendingAssistantDrafts.filter((draft) =>
			!remoteMessages.some((message) => message.id === draft.id)
		);
		pendingUserMessages = pendingUserMessages.filter(
			(pending) =>
				!remoteMessages.some(
					(remote) =>
						remote.role === 'user' &&
						remote.content === pending.content &&
						new Date(remote.createdAt).getTime() >= pending.createdAt.getTime() - 15000
				)
		);
	}

	async function loadConversationState() {
		if (!conversationId) {
			conversationData = null;
			stats = [];
			return;
		}

		const [conversationResult, statsResult] = await Promise.all([
			getConversation(conversationId),
			getMessageStats(conversationId)
		]);
		conversationData = conversationResult;
		stats = statsResult;
		reconcilePendingWithRemote(conversationResult?.messages ?? []);
	}

	async function refreshAll() {
		await Promise.all([loadConversationState(), loadConversationArtifacts()]);
	}

	function stopStreaming() {
		if (!streaming || !streamAbortController) return;
		stoppedByUser = true;
		streamAbortController.abort();
	}

	async function approveToolCall(token: string) {
		await fetch(`/chat/${conversationId}/tool-approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, approved: true }),
		});
		streamingToolCalls = streamingToolCalls.map((tc) =>
			tc.token === token ? { ...tc, status: 'approved' as const } : tc
		);
	}

	async function denyToolCall(token: string) {
		await fetch(`/chat/${conversationId}/tool-approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, approved: false }),
		});
		streamingToolCalls = streamingToolCalls.map((tc) =>
			tc.token === token ? { ...tc, status: 'denied' as const } : tc
		);
	}

	async function streamMessage(content: string, regenerate = false, attachments: ChatAttachment[] = []) {
		if (!conversationId || streaming) return;

		const abortController = new AbortController();
		const startedAt = new Date();
		const optimisticUserId = `pending-user-${startedAt.getTime()}`;
		if (!regenerate) {
			pendingUserMessages = [
				...pendingUserMessages,
				{ id: optimisticUserId, content: content.trim(), createdAt: startedAt }
			];
		}

		streaming = true;
		streamError = null;
		draftAssistant = '';
		streamedAssistantTarget = '';
		stopDraftInterpolation();
		pendingMessageId = null;
		waitingForFirstToken = true;
		streamAbortController = abortController;
		stoppedByUser = false;
		streamingToolCalls = [];
		try {
			const response = await fetch(`/chat/${conversationId}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ conversationId, content, model, regenerate, attachments }),
				signal: abortController.signal
			});

			if (!response.ok || !response.body) {
				throw new Error('Failed to open stream');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const events = buffer.split('\n\n');
				buffer = events.pop() ?? '';

				for (const raw of events) {
					const lines = raw.split('\n');
					const eventLine = lines.find((line) => line.startsWith('event: '));
					const dataLine = lines.find((line) => line.startsWith('data: '));
					if (!eventLine || !dataLine) continue;

					const eventName = eventLine.slice(7).trim();
					const payload = JSON.parse(dataLine.slice(6));

					if (eventName === 'delta') {
						waitingForFirstToken = false;
						// Collapse any expanded tool calls when text resumes
						streamingToolCalls = streamingToolCalls.map((tc) => ({ ...tc, expanded: false }));
						streamedAssistantTarget += payload.content ?? '';
						queueDraftInterpolation();
					}

					if (eventName === 'tool_pending') {
						waitingForFirstToken = false;
						// Collapse previous, add new pending tool
						streamingToolCalls = [
							...streamingToolCalls.map((tc) => ({ ...tc, expanded: false })),
							{
								id: payload.id,
								name: payload.name,
								arguments: payload.arguments ?? '',
								status: 'pending' as const,
								expanded: true,
								token: payload.token,
							},
						];
					}

					if (eventName === 'tool_call') {
						waitingForFirstToken = false;
						const existing = streamingToolCalls.find((tc) => tc.id === payload.id);
						if (existing) {
							// Update from pending → executing
							streamingToolCalls = streamingToolCalls.map((tc) =>
								tc.id === payload.id
									? { ...tc, status: 'executing' as const, expanded: true }
									: { ...tc, expanded: false }
							);
						} else {
							// Auto-approve mode — tool_call arrives directly
							streamingToolCalls = [
								...streamingToolCalls.map((tc) => ({ ...tc, expanded: false })),
								{
									id: payload.id,
									name: payload.name,
									arguments: payload.arguments ?? '',
									status: 'executing' as const,
									expanded: true,
									token: null,
								},
							];
						}
					}

					if (eventName === 'tool_result') {
						streamingToolCalls = streamingToolCalls.map((tc) =>
							tc.name === payload.name && (tc.status === 'executing' || tc.status === 'approved')
								? {
										...tc,
										status: 'completed' as const,
										executionMs: payload.executionMs ?? null,
										result: payload.result ?? (payload.success ? 'Success' : 'Failed'),
									}
								: tc
						);
					}

					if (eventName === 'tool_denied') {
						streamingToolCalls = streamingToolCalls.map((tc) =>
							tc.id === payload.id
								? { ...tc, status: 'denied' as const, expanded: true }
								: tc
						);
					}

					if (eventName === 'artifact_created') {
						// Artifact was created during tool execution — open it
						if (payload.artifactId) {
							void openArtifact(payload.artifactId);
						}
					}

					if (eventName === 'done') {
						waitingForFirstToken = false;
						if (payload.error) {
							streamError = payload.error;
						} else if (payload.messageId) {
							draftAssistant = streamedAssistantTarget;
							stopDraftInterpolation();
							// Keep draft visible until refreshAll() completes
							pendingMessageId = payload.messageId;
							if (streamedAssistantTarget.trim()) {
								pendingAssistantDrafts = [
									...pendingAssistantDrafts.filter((draft) => draft.id !== payload.messageId),
									{
										id: payload.messageId,
										content: streamedAssistantTarget,
										createdAt: new Date(),
										toolCalls: streamingToolCalls
											.filter((tc) => tc.status === 'completed')
											.map((tc) => ({ name: tc.name, arguments: JSON.parse(tc.arguments || '{}'), result: tc.result ?? '' }))
									}
								];
							}
						}
					}
				}
			}

			// Successful stream end — don't call refreshAll here; finally handles it
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				if (!stoppedByUser) {
					streamError = 'Stream interrupted';
				}
			} else {
				streamError = error instanceof Error ? error.message : 'Streaming error';
			}
		} finally {
			// Always reload messages so user & assistant messages show even after an error
			await refreshAll().catch(() => {});
			if (pendingMessageId && messages.some((message) => message.id === pendingMessageId)) {
				draftAssistant = '';
				pendingMessageId = null;
			}
			streaming = false;
			waitingForFirstToken = false;
			streamAbortController = null;
			stoppedByUser = false;
			streamingToolCalls = [];
			streamedAssistantTarget = '';
			stopDraftInterpolation();
		}
	}

	async function handleEdit(messageId: string, content: string) {
		await editMessage({ messageId, content });
		await refreshAll();
	}

	async function handleRegenerate() {
		await streamMessage('regenerate', true);
	}

	function getContextLimitForModel(modelId: string) {
		const selected = availableModels.find((candidate) => candidate.id === modelId);
		return selected?.contextLength && selected.contextLength > 0 ? selected.contextLength : 128000;
	}

	async function maybeCompactBeforeModelSwitch(nextModel: string) {
		const currentModel = model;
		if (!nextModel || nextModel === currentModel) return;
		if (streaming) {
			modelSwitchNotice = 'Wait for the current response to finish before switching models.';
			setTimeout(() => {
				modelSwitchNotice = null;
			}, 3500);
			return;
		}

		const currentLimit = getContextLimitForModel(currentModel);
		const nextLimit = getContextLimitForModel(nextModel);
		const projectedPct = nextLimit > 0 ? (contextMetrics.used / nextLimit) * 100 : 0;

		if (nextLimit < currentLimit && projectedPct >= autoCompactThresholdPct) {
			const compactionPrompt = `Please compact this conversation for handoff to a model with a smaller context window. Preserve all requirements, decisions, open tasks, constraints, and the latest user intent in a concise structured summary.`;
			await streamMessage(compactionPrompt, false);
			modelSwitchNotice = `Auto-compact ran on ${currentModel.split('/').at(-1)} before switching to ${nextModel.split('/').at(-1)}.`;
			setTimeout(() => {
				modelSwitchNotice = null;
			}, 5000);
		}

		model = nextModel;
	}

	async function compactContext() {
		console.log('Compact context requested for', conversationId);
	}
</script>

<div class="flex min-h-0 w-full flex-1 gap-0" class:artifact-split={artifactPanelMode === 'panel'}>
	<section class="flex min-h-0 flex-1 flex-col gap-1 px-1 pt-0 pb-2 sm:px-0" class:max-w-full={artifactPanelMode !== 'panel'}>
		{#if !conversationData}
			<div class="flex flex-1 items-center justify-center">
				<span class="loading loading-spinner loading-sm opacity-50"></span>
			</div>
		{:else}
			<div class="flex items-center gap-2 px-1 py-1.5 lg:px-0">
				<button onclick={() => goto('/')} class="btn btn-ghost btn-sm btn-circle lg:hidden" aria-label="Back to chats">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
				</button>
				<h1 class="min-w-0 flex-1 truncate text-base font-semibold lg:text-lg">{conversationData?.conversation.title ?? 'Chat'}</h1>
				<ContextWindow
					used={contextMetrics.used}
					total={contextMetrics.total}
					breakdown={contextMetrics.breakdown}
					modelUsage={contextMetrics.modelUsage}
					reservedTargetPct={reservedResponsePct}
					onCompact={compactContext}
				/>
			</div>

			{#if modelSwitchNotice}
				<div class="alert alert-info mt-1 mb-1 py-2 text-sm">
					<span>{modelSwitchNotice}</span>
				</div>
			{/if}

			<div bind:this={messagesEl} class="min-h-0 flex-1 space-y-2 overflow-y-auto px-0.5 py-1">
				{#each displayedMessages as message (message.id)}
					<MessageBubble {message} artifacts={conversationArtifacts} onEdit={handleEdit} onRegenerate={handleRegenerate} onOpenArtifact={openArtifact} />
				{/each}

				{#if waitingForFirstToken && streaming && !draftAssistant && streamingToolCalls.length === 0}
					<article class="chat chat-start">
						<div>
							<svg class="h-8 w-16" viewBox="0 0 80 32" aria-label="Assistant is generating a response">
								<circle cx="16" cy="16" r="5" fill="currentColor" class="opacity-60">
									<animate attributeName="r" values="5;7;5" dur="1.2s" repeatCount="indefinite" begin="0s" />
									<animate attributeName="opacity" values="0.4;1;0.4" dur="1.2s" repeatCount="indefinite" begin="0s" />
								</circle>
								<circle cx="40" cy="16" r="5" fill="currentColor" class="opacity-60">
									<animate attributeName="r" values="5;7;5" dur="1.2s" repeatCount="indefinite" begin="0.2s" />
									<animate attributeName="opacity" values="0.4;1;0.4" dur="1.2s" repeatCount="indefinite" begin="0.2s" />
								</circle>
								<circle cx="64" cy="16" r="5" fill="currentColor" class="opacity-60">
									<animate attributeName="r" values="5;7;5" dur="1.2s" repeatCount="indefinite" begin="0.4s" />
									<animate attributeName="opacity" values="0.4;1;0.4" dur="1.2s" repeatCount="indefinite" begin="0.4s" />
								</circle>
							</svg>
						</div>
					</article>
				{:else if streaming}
					{#if streamingToolCalls.length > 0}
						<div class="w-full space-y-1.5 pl-1">
							{#each streamingToolCalls as tc (tc.id)}
								<LiveToolCallCard
									name={tc.name}
									argumentsText={tc.arguments}
									result={tc.result ?? ''}
									status={tc.status}
									executionMs={tc.executionMs ?? null}
									expanded={tc.expanded}
									token={tc.token ?? null}
									onApprove={approveToolCall}
									onDeny={denyToolCall}
								/>
							{/each}
						</div>
					{/if}
					{#if draftAssistant}
						<article class="chat chat-start">
							<div class="assistant-message pl-4"><div class="markdown-body">{@html renderMarkdown(draftAssistant)}</div></div>
						</article>
					{/if}
				{/if}
			</div>

			{#if streamError}
				<p class="text-sm text-error">{streamError}</p>
			{/if}
		{/if}

		<div class="chat-composer-transition">
			<ChatInput
				busy={streaming}
				onCancelGeneration={stopStreaming}
				model={model}
				onModelChange={(next) => maybeCompactBeforeModelSwitch(next)}
				onSubmit={(content, attachments) => streamMessage(content, false, attachments)}
				estimatedRemaining={Math.max(0, contextMetrics.total - contextMetrics.used)}
			/>
		</div>
	</section>

	{#if artifactPanelMode === 'panel' || artifactPanelMode === 'fullscreen'}
		<div class="hidden min-h-0 w-[55%] shrink-0 border-l border-base-300 lg:block" class:!block={artifactPanelMode === 'fullscreen'}>
			<ArtifactPanel
				artifact={activeArtifact}
				mode={artifactPanelMode}
				onClose={closeArtifactPanel}
				onPin={handlePinArtifact}
			/>
		</div>
	{/if}
</div>

