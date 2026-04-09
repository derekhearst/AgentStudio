<svelte:head><title>{conversationData?.conversation.title ?? 'Chat'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import {
		editMessage,
		getConversation,
		getMessageStats,
	} from '$lib/chat';
	import { savePartialAssistant } from '$lib/chat/chat.remote';
	import { getAvailableModels } from '$lib/models';
	import { getSettings } from '$lib/settings';
	import { getArtifact, getArtifactsByConversation, pinArtifact as pinArtifactCommand } from '$lib/artifacts';
	import ChatInput from '$lib/chat/ChatInput.svelte';
	import ContextWindow from '$lib/chat/ContextWindow.svelte';
	import MessageBubble from '$lib/chat/MessageBubble.svelte';
	import LiveToolCallCard from '$lib/chat/LiveToolCallCard.svelte';
	import ThinkingBlockCard from '$lib/chat/ThinkingBlockCard.svelte';
	import AskUserModal from '$lib/chat/AskUserModal.svelte';
	import PlanApprovalCard from '$lib/chat/PlanApprovalCard.svelte';
	import SubagentBlockCard from '$lib/chat/SubagentBlockCard.svelte';
	import { renderMarkdown } from '$lib/chat/chat';
	import ArtifactPanel from '$lib/artifacts/ArtifactPanel.svelte';

	type ChatAttachment = {
		id: string;
		filename: string;
		mimeType: string;
		size: number;
		url: string;
	};

	type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	const REASONING_STORAGE_KEY = 'AgentStudio:reasoning-effort';
	const VALID_REASONING_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

	type AskUserOption = {
		label: string;
		description?: string;
		recommended?: boolean;
	};

	type AskUserQuestion = {
		header: string;
		question: string;
		options: AskUserOption[];
		allowFreeformInput?: boolean;
	};

	type ToolStatus = 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'denied';

	type TextBlock = {
		kind: 'text';
		id: string;
		content: string;
	};

	type ToolBlock = {
		kind: 'tool';
		id: string;
		name: string;
		arguments: string;
		status: ToolStatus;
		result?: string;
		executionMs?: number | null;
		expanded: boolean;
		token?: string | null;
	};

	type ThinkingBlock = {
		kind: 'thinking';
		id: string;
		content: string;
		reasoningTokens?: number | null;
		expanded: boolean;
	};

	type PlanBlock = {
		kind: 'plan';
		id: string;
		token: string;
		status: 'pending' | 'approved' | 'denied' | 'continued';
		tools: Array<{ id: string; name: string; argumentsText: string }>;
	};

	type SubagentBlock = {
		kind: 'subagent';
		id: string;
		agentId: string;
		agentName: string;
		conversationId: string | null;
		task: string;
		content: string;
		status: 'running' | 'completed' | 'failed';
		toolCalls: Array<{ name: string; success?: boolean }>;
		expanded: boolean;
	};

	type StreamingBlock = TextBlock | ToolBlock | ThinkingBlock | PlanBlock | SubagentBlock;

	const conversationId = $derived(page.params.id ?? '');
	let model = $state('anthropic/claude-sonnet-4');
	let reasoningEffort = $state<ReasoningEffort>('none');
	let reasoningHydratedFor = $state<string | null>(null);
	let streaming = $state(false);
	let streamError = $state<string | null>(null);
	let streamingBlocks = $state<StreamingBlock[]>([]);
	let currentTextTarget = $state('');
	let pendingMessageId = $state<string | null>(null);
	let pendingUserMessages = $state<Array<{ id: string; content: string; createdAt: Date }>>([]);
	let pendingAssistantDrafts = $state<Array<{ id: string; content: string; createdAt: Date; toolCalls?: Array<Record<string, unknown>> }>>([]);
	let waitingForFirstToken = $state(false);
	let streamAbortController = $state<AbortController | null>(null);
	let stoppedByUser = $state(false);
	let conversationData = $state<Awaited<ReturnType<typeof getConversation>> | null>(null);
	let stats = $state<Awaited<ReturnType<typeof getMessageStats>>>([]);
	let availableModels = $derived(await getAvailableModels());
	let appSettings = $derived(await getSettings());
	let messagesEl = $state<HTMLDivElement | undefined>(undefined);
	let consumedInitialPrompt = $state(false);
	let modelSwitchNotice = $state<string | null>(null);
	let defaultModelApplied = $state(false);
	let draftInterpolationFrame = $state<number | null>(null);
	let draftInterpolationLastTs = $state<number | null>(null);
	let thinkingInterpolationFrame = $state<number | null>(null);
	let thinkingInterpolationLastTs = $state<number | null>(null);
	let currentThinkingTarget = $state('');
	let pendingAskUser = $state<{ token: string; questions: AskUserQuestion[] } | null>(null);
	let askUserModalOpen = $state(false);

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

	function stopThinkingInterpolation() {
		if (thinkingInterpolationFrame !== null) {
			cancelAnimationFrame(thinkingInterpolationFrame);
			thinkingInterpolationFrame = null;
		}
		thinkingInterpolationLastTs = null;
	}

	function interpolateThinking(now: number) {
		thinkingInterpolationFrame = null;
		if (thinkingInterpolationLastTs === null) {
			thinkingInterpolationLastTs = now;
		}

		const elapsedMs = now - thinkingInterpolationLastTs;
		thinkingInterpolationLastTs = now;

		let lastThinkingIdx = -1;
		for (let i = streamingBlocks.length - 1; i >= 0; i--) {
			if (streamingBlocks[i].kind === 'thinking') {
				lastThinkingIdx = i;
				break;
			}
		}
		if (lastThinkingIdx === -1) {
			stopThinkingInterpolation();
			return;
		}

		const block = streamingBlocks[lastThinkingIdx];
		if (block.kind !== 'thinking') {
			stopThinkingInterpolation();
			return;
		}

		const remaining = currentThinkingTarget.length - block.content.length;
		if (remaining <= 0) {
			stopThinkingInterpolation();
			return;
		}

		const charsPerSecond = Math.min(220, Math.max(70, remaining * 3));
		const step = Math.max(1, Math.floor((charsPerSecond * Math.max(16, elapsedMs)) / 1000));
		const newContent = currentThinkingTarget.slice(0, block.content.length + step);

		streamingBlocks = streamingBlocks.map((b, i) =>
			i === lastThinkingIdx && b.kind === 'thinking' ? { ...b, content: newContent } : b
		);

		if (newContent.length < currentThinkingTarget.length) {
			thinkingInterpolationFrame = requestAnimationFrame(interpolateThinking);
		} else {
			stopThinkingInterpolation();
		}
	}

	function queueThinkingInterpolation() {
		let lastThinkingBlock: ThinkingBlock | undefined;
		for (let i = streamingBlocks.length - 1; i >= 0; i--) {
			const b = streamingBlocks[i];
			if (b.kind === 'thinking') {
				lastThinkingBlock = b;
				break;
			}
		}
		if (!lastThinkingBlock) return;
		if (lastThinkingBlock.content.length >= currentThinkingTarget.length) return;
		if (thinkingInterpolationFrame !== null) return;
		thinkingInterpolationFrame = requestAnimationFrame(interpolateThinking);
	}

	function interpolateDraft(now: number) {
		draftInterpolationFrame = null;
		if (draftInterpolationLastTs === null) {
			draftInterpolationLastTs = now;
		}

		const elapsedMs = now - draftInterpolationLastTs;
		draftInterpolationLastTs = now;

		// Find the last text block
		let lastTextIdx = -1;
		for (let i = streamingBlocks.length - 1; i >= 0; i--) {
			if (streamingBlocks[i].kind === 'text') { lastTextIdx = i; break; }
		}
		if (lastTextIdx === -1) { stopDraftInterpolation(); return; }

		const block = streamingBlocks[lastTextIdx];
		if (block.kind !== 'text') { stopDraftInterpolation(); return; }

		const remaining = currentTextTarget.length - block.content.length;
		if (remaining <= 0) { stopDraftInterpolation(); return; }

		const charsPerSecond = Math.min(280, Math.max(80, remaining * 4));
		const step = Math.max(1, Math.floor((charsPerSecond * Math.max(16, elapsedMs)) / 1000));
		const newContent = currentTextTarget.slice(0, block.content.length + step);

		streamingBlocks = streamingBlocks.map((b, i) =>
			i === lastTextIdx && b.kind === 'text' ? { ...b, content: newContent } : b
		);

		if (newContent.length < currentTextTarget.length) {
			draftInterpolationFrame = requestAnimationFrame(interpolateDraft);
		} else {
			stopDraftInterpolation();
		}
	}

	function queueDraftInterpolation() {
		let lastTextBlock: TextBlock | undefined;
		for (let i = streamingBlocks.length - 1; i >= 0; i--) {
			const b = streamingBlocks[i];
			if (b.kind === 'text') { lastTextBlock = b; break; }
		}
		if (!lastTextBlock) return;
		if (lastTextBlock.content.length >= currentTextTarget.length) return;
		if (draftInterpolationFrame !== null) return;
		draftInterpolationFrame = requestAnimationFrame(interpolateDraft);
	}

	function appendThinkingContent(content: string) {
		if (!content) return;
		const lastIdx = streamingBlocks.length - 1;
		const lastBlock = streamingBlocks[lastIdx];
		if (lastBlock?.kind === 'thinking') {
			currentThinkingTarget += content;
			// Re-expand if user or a prior event collapsed it
			if (!lastBlock.expanded) {
				streamingBlocks = streamingBlocks.map((b, i) =>
					i === lastIdx && b.kind === 'thinking' ? { ...b, expanded: true } : b
				);
			}
			queueThinkingInterpolation();
			return;
		}

		streamingBlocks = [
			...streamingBlocks,
			{
				kind: 'thinking' as const,
				id: `thinking-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				content: '',
				reasoningTokens: null,
				expanded: true,
			}
		];
		currentThinkingTarget = content;
		queueThinkingInterpolation();
	}

	function updateLatestReasoningTokens(reasoningTokens: number | null | undefined) {
		if (typeof reasoningTokens !== 'number' || reasoningTokens <= 0) return;
		for (let i = streamingBlocks.length - 1; i >= 0; i--) {
			const block = streamingBlocks[i];
			if (block.kind !== 'thinking') continue;
			streamingBlocks = streamingBlocks.map((entry, idx) =>
				idx === i && entry.kind === 'thinking' ? { ...entry, reasoningTokens } : entry
			);
			break;
		}
	}

	/** Commit currentTextTarget into the last text block and stop animation. */
	function finalizeCurrentTextBlock() {
		stopDraftInterpolation();
		if (!currentTextTarget) return;
		const lastIdx = streamingBlocks.length - 1;
		if (lastIdx >= 0 && streamingBlocks[lastIdx].kind === 'text') {
			streamingBlocks = streamingBlocks.map((b, i) =>
				i === lastIdx && b.kind === 'text' ? { ...b, content: currentTextTarget } : b
			);
		}
		currentTextTarget = '';
	}

	function finalizeCurrentThinkingBlock() {
		stopThinkingInterpolation();
		if (!currentThinkingTarget) return;
		const lastIdx = streamingBlocks.length - 1;
		if (lastIdx >= 0 && streamingBlocks[lastIdx].kind === 'thinking') {
			streamingBlocks = streamingBlocks.map((b, i) =>
				i === lastIdx && b.kind === 'thinking' ? { ...b, content: currentThinkingTarget } : b
			);
		}
		currentThinkingTarget = '';
	}

	function parseJsonFallback(raw: string) {
		try {
			return JSON.parse(raw || '{}');
		} catch {
			return {};
		}
	}

	function getPartialTextFromBlocks() {
		return streamingBlocks
			.filter((b) => b.kind === 'text')
			.map((b) => (b.kind === 'text' ? b.content : ''))
			.join('');
	}

	function getThinkingTextFromBlocks() {
		return streamingBlocks
			.filter((b) => b.kind === 'thinking')
			.map((b) => (b.kind === 'thinking' ? b.content : ''))
			.join('\n\n');
	}

	function getLatestReasoningTokensFromBlocks() {
		for (let i = streamingBlocks.length - 1; i >= 0; i--) {
			const block = streamingBlocks[i];
			if (block.kind === 'thinking' && typeof block.reasoningTokens === 'number') {
				return block.reasoningTokens;
			}
		}
		return null;
	}

	function getSerializableBlocksForMetadata() {
		return streamingBlocks
			.map((block) => {
				if (block.kind === 'text') {
					if (!block.content.trim()) return null;
					return { kind: 'text' as const, content: block.content };
				}
				if (block.kind === 'thinking') {
					if (!block.content.trim()) return null;
					return {
						kind: 'thinking' as const,
						content: block.content,
						reasoningTokens: block.reasoningTokens ?? null,
					};
				}
				if (block.kind === 'plan') {
					return {
						kind: 'plan' as const,
						status: block.status,
						tools: block.tools,
					};
				}
				if (block.kind === 'subagent') {
					return {
						kind: 'subagent' as const,
						agentId: block.agentId,
						agentName: block.agentName,
						conversationId: block.conversationId,
						task: block.task,
						content: block.content,
						success: block.status === 'completed',
					};
				}
				return {
					kind: 'tool' as const,
					name: block.name,
					arguments: parseJsonFallback(block.arguments),
					result: block.result ?? '',
					success: block.status === 'completed',
					executionMs: block.executionMs ?? 0,
				};
			})
			.filter(Boolean);
	}

	function getCompletedToolCallsFromBlocks() {
		return streamingBlocks
			.filter((b) => b.kind === 'tool' && (b.status === 'completed' || b.status === 'failed' || b.status === 'denied'))
			.map((b) =>
				b.kind === 'tool'
					? {
						name: b.name,
						arguments: parseJsonFallback(b.arguments),
						result: b.result ?? '',
						status: b.status,
					}
					: null
			)
			.filter(Boolean) as Array<Record<string, unknown>>;
	}

	async function persistCanceledPartialIfAny() {
		if (!stoppedByUser || pendingMessageId) return;
		finalizeCurrentThinkingBlock();
		finalizeCurrentTextBlock();

		const textContent = getPartialTextFromBlocks().trim();
		const thinkingContent = getThinkingTextFromBlocks().trim();
		const contentToPersist = textContent || thinkingContent;
		if (!contentToPersist) return;

		await savePartialAssistant({
			conversationId,
			content: contentToPersist,
			model,
			toolCalls: getCompletedToolCallsFromBlocks(),
			metadata: {
				partial: true,
				stoppedByUser: true,
				reasoningEffort,
				reasoningTokens: getLatestReasoningTokensFromBlocks(),
				blocks: getSerializableBlocksForMetadata(),
			},
		});
	}

	$effect(() => {
		// Auto-scroll when messages change or during streaming
		void messages.length;
		void streamingBlocks.map((b) =>
			b.kind === 'tool'
				? `${b.id}:${b.status}:${b.expanded}:${b.result?.length ?? 0}`
				: b.kind === 'thinking'
					? `${b.id}:${b.content.length}:${b.reasoningTokens ?? 0}`
					: b.kind === 'plan'
						? `${b.id}:${b.status}:${b.tools.length}`
						: `${b.id}:${b.content.length}`
		).join('|');
		scrollToBottom();
	});

	$effect(() => {
		return () => {
			stopDraftInterpolation();
			stopThinkingInterpolation();
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
		if (!browser) return;
		if (conversationId === reasoningHydratedFor) return;

		const scopedKey = conversationId ? `${REASONING_STORAGE_KEY}:${conversationId}` : null;
		const scoped = scopedKey ? window.localStorage.getItem(scopedKey) : null;
		const global = window.localStorage.getItem(REASONING_STORAGE_KEY);
		const stored = scoped ?? global;

		if (stored && VALID_REASONING_EFFORTS.includes(stored as ReasoningEffort)) {
			reasoningEffort = stored as ReasoningEffort;
		}

		reasoningHydratedFor = conversationId;
	});



	$effect(() => {
		if (!browser) return;
		if (reasoningHydratedFor !== conversationId) return;

		window.localStorage.setItem(REASONING_STORAGE_KEY, reasoningEffort);
		if (conversationId) {
			window.localStorage.setItem(`${REASONING_STORAGE_KEY}:${conversationId}`, reasoningEffort);
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
			streamingBlocks = [];
			currentTextTarget = '';
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
		finalizeCurrentThinkingBlock();
		finalizeCurrentTextBlock();
		stoppedByUser = true;
		streamAbortController.abort();
	}

	async function approveToolCall(token: string) {
		await fetch(`/chat/${conversationId}/tool-approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, approved: true }),
		});
		streamingBlocks = streamingBlocks.map((b) =>
			b.kind === 'tool' && b.token === token ? { ...b, status: 'approved' as const } : b
		);
	}

	async function denyToolCall(token: string) {
		await fetch(`/chat/${conversationId}/tool-approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, approved: false }),
		});
		streamingBlocks = streamingBlocks.map((b) =>
			b.kind === 'tool' && b.token === token ? { ...b, status: 'denied' as const } : b
		);
	}

	async function decidePlan(token: string, decision: 'approve' | 'deny' | 'continue') {
		await fetch(`/chat/${conversationId}/plan-decide`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, decision }),
		});

		streamingBlocks = streamingBlocks.map((b) =>
			b.kind === 'plan' && b.token === token
				? {
						...b,
						status:
							decision === 'approve'
								? ('approved' as const)
								: decision === 'continue'
									? ('continued' as const)
									: ('denied' as const),
				  }
				: b,
		);
	}

	function buildAskUserAnswersFromFreeform(freeform: string): Record<string, string> {
		if (!pendingAskUser) return {};
		const trimmed = freeform.trim();
		if (!trimmed) return {};

		return Object.fromEntries(
			pendingAskUser.questions
				.filter((question) => question.header.trim().length > 0)
				.map((question) => [question.header, trimmed])
		);
	}

	async function resolveAskUser(answers: Record<string, string>) {
		if (!pendingAskUser) return;
		const { token } = pendingAskUser;
		const response = await fetch(`/chat/${conversationId}/ask-user`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, answers }),
		});

		if (!response.ok) {
			throw new Error('Failed to submit ask_user answers');
		}

		pendingAskUser = null;
		askUserModalOpen = false;
	}

	function closeAskUserModal() {
		askUserModalOpen = false;
	}

	function skipAskUserToChat() {
		askUserModalOpen = false;
	}

	async function handleComposerSubmit(content: string, attachments: ChatAttachment[]) {
		if (pendingAskUser) {
			const freeformAnswers = buildAskUserAnswersFromFreeform(content);
			if (Object.keys(freeformAnswers).length === 0) return;
			await resolveAskUser(freeformAnswers);
			return;
		}

		await streamMessage(content, false, attachments);
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
		streamingBlocks = [];
		currentTextTarget = '';
		currentThinkingTarget = '';
		stopDraftInterpolation();
		stopThinkingInterpolation();
		pendingMessageId = null;
		waitingForFirstToken = true;
		streamAbortController = abortController;
		stoppedByUser = false;
		try {
			const response = await fetch(`/chat/${conversationId}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					conversationId,
					content,
					model,
					reasoningEffort,
					regenerate,
					attachments,
				}),
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
						finalizeCurrentThinkingBlock();
						const lastBlock = streamingBlocks.at(-1);
						if (!lastBlock || lastBlock.kind !== 'text') {
							// Collapse any expanded tool blocks when text starts again
							streamingBlocks = [
								...streamingBlocks.map((b) => b.kind === 'tool' ? { ...b, expanded: false } : b),
								{ kind: 'text' as const, id: `txt-${Date.now()}-${Math.random().toString(36).slice(2)}`, content: '' },
							];
						}
						currentTextTarget += payload.content ?? '';
						queueDraftInterpolation();
					}

					if (eventName === 'reasoning') {
						waitingForFirstToken = false;
						appendThinkingContent(payload.content ?? '');
					}

					if (eventName === 'plan_pending') {
						waitingForFirstToken = false;
						finalizeCurrentThinkingBlock();
						finalizeCurrentTextBlock();
						streamingBlocks = [
							...streamingBlocks,
							{
								kind: 'plan' as const,
								id: `plan-${payload.token}`,
								token: payload.token,
								status: 'pending' as const,
								tools: Array.isArray(payload.tools)
									? payload.tools.map((tool: { id?: string; name?: string; arguments?: string }) => ({
											id: tool.id ?? `tool-${Math.random().toString(36).slice(2)}`,
											name: tool.name ?? 'unknown',
											argumentsText: tool.arguments ?? '',
									  }))
									: [],
							},
						];
					}

					if (eventName === 'plan_decision') {
						const decision = payload.decision as 'approve' | 'deny' | 'continue' | undefined;
						streamingBlocks = streamingBlocks.map((b) =>
							b.kind === 'plan' && b.token === payload.token
								? {
										...b,
										status:
											decision === 'approve'
												? ('approved' as const)
												: decision === 'continue'
													? ('continued' as const)
													: ('denied' as const),
								  }
								: b,
						);
					}

					if (eventName === 'tool_pending') {
						waitingForFirstToken = false;
						finalizeCurrentThinkingBlock();
						finalizeCurrentTextBlock();
						streamingBlocks = [
							...streamingBlocks.map((b) =>
								b.kind === 'tool' ? { ...b, expanded: false } :
								b.kind === 'thinking' ? { ...b, expanded: false } : b
							),
							{
								kind: 'tool' as const,
								id: payload.id,
								name: payload.name,
								arguments: payload.arguments ?? '',
								status: 'pending' as const,
								expanded: true,
								token: payload.token,
							},
						];
					}

					if (eventName === 'ask_user') {
						waitingForFirstToken = false;
						// Collapse any open thinking blocks while waiting for user input
						streamingBlocks = streamingBlocks.map((b) =>
							b.kind === 'thinking' ? { ...b, expanded: false } : b
						);
						pendingAskUser = {
							token: payload.token,
							questions: payload.questions ?? []
						};
						askUserModalOpen = true;
					}

					if (eventName === 'tool_call') {
						waitingForFirstToken = false;
						const existing = streamingBlocks.find((b) => b.kind === 'tool' && b.id === payload.id);
						if (existing) {
							// Update pending → executing; also collapse any thinking blocks
							streamingBlocks = streamingBlocks.map((b) =>
								b.kind === 'tool' && b.id === payload.id
									? { ...b, status: 'executing' as const, expanded: true }
									: b.kind === 'tool' ? { ...b, expanded: false }
									: b.kind === 'thinking' ? { ...b, expanded: false } : b
							);
						} else {
							// Auto-approve mode — tool_call arrives directly
							finalizeCurrentThinkingBlock();
							finalizeCurrentTextBlock();
							streamingBlocks = [
								...streamingBlocks.map((b) =>
									b.kind === 'tool' ? { ...b, expanded: false } :
									b.kind === 'thinking' ? { ...b, expanded: false } : b
								),
								{
									kind: 'tool' as const,
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
						if (payload.name === 'ask_user') {
							pendingAskUser = null;
							askUserModalOpen = false;
						}
						streamingBlocks = streamingBlocks.map((b) =>
							b.kind === 'tool' && b.id === payload.id && (b.status === 'executing' || b.status === 'approved')
								? {
										...b,
										status: payload.success ? ('completed' as const) : ('failed' as const),
										executionMs: payload.executionMs ?? null,
										result: payload.result ?? (payload.success ? 'Success' : 'Tool execution failed'),
									}
								: b
						);
					}

					if (eventName === 'tool_denied') {
						streamingBlocks = streamingBlocks.map((b) =>
							b.kind === 'tool' && b.id === payload.id
								? { ...b, status: 'denied' as const, expanded: true }
								: b
						);
					}

					if (eventName === 'artifact_created') {
						// Artifact was created during tool execution — open it
						if (payload.artifactId) {
							void openArtifact(payload.artifactId);
						}
					}

					if (eventName === 'subagent_start') {
						waitingForFirstToken = false;
						finalizeCurrentThinkingBlock();
						finalizeCurrentTextBlock();
						streamingBlocks = [
							...streamingBlocks.map((b) =>
								b.kind === 'thinking' ? { ...b, expanded: false } : b
							),
							{
								kind: 'subagent' as const,
								id: `subagent-${payload.agentId}-${payload.conversationId}`,
								agentId: payload.agentId,
								agentName: payload.agentName,
								conversationId: payload.conversationId,
								task: payload.task ?? '',
								content: '',
								status: 'running' as const,
								toolCalls: [],
								expanded: true,
							},
						];
					}

					if (eventName === 'subagent_delta') {
						streamingBlocks = streamingBlocks.map((b) =>
							b.kind === 'subagent' && b.agentId === payload.agentId && b.conversationId === payload.conversationId
								? { ...b, content: b.content + (payload.content ?? '') }
								: b
						);
					}

					if (eventName === 'subagent_tool_call') {
						streamingBlocks = streamingBlocks.map((b) =>
							b.kind === 'subagent' && b.agentId === payload.agentId && b.conversationId === payload.conversationId
								? { ...b, toolCalls: [...b.toolCalls, { name: payload.name }] }
								: b
						);
					}

					if (eventName === 'subagent_tool_result') {
						streamingBlocks = streamingBlocks.map((b) => {
							if (b.kind !== 'subagent' || b.agentId !== payload.agentId || b.conversationId !== payload.conversationId) return b;
							const updatedTools = b.toolCalls.map((tc, i) =>
								i === b.toolCalls.length - 1 && tc.name === payload.name
									? { ...tc, success: payload.success }
									: tc
							);
							return { ...b, toolCalls: updatedTools };
						});
					}

					if (eventName === 'subagent_done') {
						streamingBlocks = streamingBlocks.map((b) =>
							b.kind === 'subagent' && b.agentId === payload.agentId && b.conversationId === payload.conversationId
								? { ...b, status: 'completed' as const, expanded: false }
								: b
						);
					}

					if (eventName === 'metrics') {
						updateLatestReasoningTokens(payload.reasoningTokens ?? null);
					}

					if (eventName === 'done') {
						waitingForFirstToken = false;
						if (payload.error) {
							streamError = payload.error;
						} else if (payload.messageId) {
							finalizeCurrentThinkingBlock();
							finalizeCurrentTextBlock();
							// Keep content visible until refreshAll() confirms DB message
							pendingMessageId = payload.messageId;
							const fullText = getPartialTextFromBlocks();
							if (fullText.trim()) {
								pendingAssistantDrafts = [
									...pendingAssistantDrafts.filter((draft) => draft.id !== payload.messageId),
									{
										id: payload.messageId,
										content: fullText,
										createdAt: new Date(),
										toolCalls: getCompletedToolCallsFromBlocks(),
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
			await persistCanceledPartialIfAny().catch(() => {});

			// Always reload messages so user & assistant messages show even after an error
			await refreshAll().catch(() => {});
			if (pendingMessageId && messages.some((message) => message.id === pendingMessageId)) {
				streamingBlocks = [];
				currentTextTarget = '';
				pendingMessageId = null;
			}
			streaming = false;
			waitingForFirstToken = false;
			streamAbortController = null;
			stoppedByUser = false;
			streamingBlocks = [];
			currentTextTarget = '';
			currentThinkingTarget = '';
			stopDraftInterpolation();
			stopThinkingInterpolation();
		}
	}

	async function handleEdit(messageId: string, content: string) {
		try {
			const result = await editMessage({ messageId, content });
			if (!result || result.success !== true) {
				streamError = result?.error ?? 'Unable to edit message';
				return;
			}

			// Editing creates a new branch point. Clear optimistic remnants so
			// old assistant drafts cannot be re-shown after the server truncates history.
			pendingAssistantDrafts = [];
			pendingUserMessages = [];
			pendingMessageId = null;
			streamingBlocks = [];
			currentTextTarget = '';
			currentThinkingTarget = '';
			stopDraftInterpolation();
			stopThinkingInterpolation();

			await refreshAll();
			await streamMessage('regenerate', true);
		} catch (error) {
			streamError = error instanceof Error ? error.message : 'Unable to edit message';
		}
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
	<section class="relative flex min-h-0 flex-1 flex-col gap-1 px-0 pt-0 pb-0 desktop:px-1 desktop:pb-1" class:max-w-full={artifactPanelMode !== 'panel'}>
		{#if !conversationData}
			<div class="flex flex-1 items-center justify-center">
				<span class="loading loading-spinner loading-sm opacity-50"></span>
			</div>
		{:else}

			<!-- Header: mobile/tablet only. Desktop uses the RecentChats sidebar panel. -->
			<div class="flex shrink-0 items-center gap-1.5 border-b border-base-300/50 bg-base-100/85 px-3 py-2 backdrop-blur-sm desktop:hidden tablet:rounded-t-[calc(1.5rem-1px)] tablet:px-4">
				<a href="/" class="btn btn-ghost btn-sm btn-square" aria-label="Back to chats">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
					</svg>
				</a>
				<h1 class="min-w-0 flex-1 truncate text-sm leading-tight font-semibold">
					{conversationData.conversation.title}
				</h1>
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

			<div bind:this={messagesEl} class="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2 tablet:px-4 tablet:py-3 desktop:px-0.5 desktop:py-1">
				{#each displayedMessages as message (message.id)}
					<MessageBubble {message} artifacts={conversationArtifacts} onEdit={handleEdit} onRegenerate={handleRegenerate} onOpenArtifact={openArtifact} />
				{/each}

				{#if waitingForFirstToken && streaming && streamingBlocks.length === 0}
					<article class="chat chat-start">
						<div class="flex items-center gap-3 px-4 py-3 text-sm text-base-content/70">
							<span class="loading loading-spinner loading-md text-primary"></span>
							<span class="sr-only">Assistant is generating a response</span>
						</div>
					</article>
				{:else if streaming}
					{#each streamingBlocks as block (block.id)}
						{#if block.kind === 'tool'}
							<LiveToolCallCard
								name={block.name}
								argumentsText={block.arguments}
								result={block.result ?? ''}
								status={block.status === 'failed' ? 'completed' : block.status}
								failed={block.status === 'failed'}
								executionMs={block.executionMs ?? null}
								expanded={block.expanded}
								token={block.token ?? null}
								onApprove={approveToolCall}
								onDeny={denyToolCall}
							/>
						{:else if block.kind === 'thinking'}
							<div class="w-full">
								<ThinkingBlockCard
									content={block.content}
									reasoningTokens={block.reasoningTokens ?? null}
									live={true}
									expanded={block.expanded}
								/>
							</div>
						{:else if block.kind === 'plan'}
							<PlanApprovalCard
								token={block.token}
								tools={block.tools}
								status={block.status}
								onApprove={(token) => decidePlan(token, 'approve')}
								onDeny={(token) => decidePlan(token, 'deny')}
								onContinue={(token) => decidePlan(token, 'continue')}
							/>
						{:else if block.kind === 'subagent'}
							<SubagentBlockCard
								agentName={block.agentName}
								agentId={block.agentId}
								conversationId={block.conversationId}
								task={block.task}
								content={block.content}
								status={block.status}
								toolCalls={block.toolCalls}
								expanded={block.expanded}
							/>
						{:else if block.kind === 'text' && block.content}
							<article class="chat chat-start">
								<div class="assistant-message rounded-2xl border border-base-300/55 bg-base-100/36 px-4 py-3"><div class="markdown-body">{@html renderMarkdown(block.content)}</div></div>
							</article>
						{/if}
					{/each}
				{/if}
			</div>

			{#if streamError}
				<p class="text-sm text-error">{streamError}</p>
			{/if}
		{/if}

		<div class="chat-composer-transition px-2 pb-2 tablet:px-4 tablet:pb-4 desktop:px-0 desktop:pb-0">

			<AskUserModal
				open={askUserModalOpen && !!pendingAskUser}
				questions={pendingAskUser?.questions ?? []}
				onSubmit={resolveAskUser}
				onClose={closeAskUserModal}
				onSkipToChat={skipAskUserToChat}
			/>

			<ChatInput
				busy={streaming && !pendingAskUser}
				onCancelGeneration={stopStreaming}
				model={model}
				reasoningEffort={reasoningEffort}
				onModelChange={(next) => maybeCompactBeforeModelSwitch(next)}
				onReasoningEffortChange={(next) => {
					reasoningEffort = next;
				}}
				onSubmit={(content, attachments) => handleComposerSubmit(content, attachments)}
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




