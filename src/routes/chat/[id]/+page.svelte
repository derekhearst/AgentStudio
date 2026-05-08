<svelte:head><title>{conversationData?.conversation.title ?? 'Chat'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import {
		deleteMessagesAfter,
		editMessage,
		getConversation,
		getMessageStats,
	} from '$lib/chat';
	import { savePartialAssistant, setConversationAgent, listAgentsForPicker } from '$lib/chat/chat.remote';

	type AgentChoice = Awaited<ReturnType<typeof listAgentsForPicker>>[number];
	import { getAvailableModels } from '$lib/llm';
	import { getSettings } from '$lib/settings';
	import ChatInput from '$lib/chat/ChatInput.svelte';
	import ContextWindow from '$lib/chat/ContextWindow.svelte';
	import { consoleState } from '$lib/chat-console/console-state.svelte';
	import Icon from '$lib/chat-console/Icon.svelte';
	import MessageBubble from '$lib/chat/MessageBubble.svelte';
	import ToolCallCard from '$lib/chat/ToolCallCard.svelte';
	import ThinkingBlockCard from '$lib/chat/ThinkingBlockCard.svelte';
	import AskUserModal from '$lib/chat/AskUserModal.svelte';
	import AskUserCard from '$lib/chat/AskUserCard.svelte';
	import SubagentBlockCard from '$lib/chat/SubagentBlockCard.svelte';
	import ArtifactCard from '$lib/chat/ArtifactCard.svelte';
	import { renderMarkdown } from '$lib/chat/chat';
	import {
		parseJsonFallback,
		getAskUserQuestionsFromTool,
		getAskUserAnswersFromTool,
		getArtifactCardFromTool,
		type AskUserOption,
		type AskUserQuestion,
	} from '$lib/chat/tool-block-helpers';
	import {
		applySubagentDelta,
		applySubagentDone,
		applySubagentStart,
		applySubagentToolCall,
		applySubagentToolResult,
		applyToolDenied,
		buildDisplayedMessages,
		estimateTokens,
		getCompletedToolCalls,
		getLatestReasoningTokens,
		getPartialText,
		getSerializableBlocksForMetadata,
		getThinkingText,
		reconcilePendingDrafts,
		type StreamingBlock,
		type TextBlock,
		type ThinkingBlock,
		type ToolStatus,
	} from '$lib/chat/streaming-blocks';
	import { computeContextMetrics } from '$lib/chat/context-metrics';

	type ChatAttachment = {
		id: string;
		filename: string;
		mimeType: string;
		size: number;
		url: string;
	};

	import { loadReasoningEffort, saveReasoningEffort, type ReasoningEffort } from '$lib/chat/reasoning-effort';

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
	type LiveContextStats = {
		runId: string | null;
		tokenEstimate: number | null;
		contextWindow: number | null;
		didCompact: boolean;
		includedSlots: string[];
		droppedSlots: string[];
		truncatedSlots: string[];
		systemPromptTokens: number | null;
	};
	let liveContextStats = $state<LiveContextStats | null>(null);
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


	type RetryIntent =
		| {
				kind: 'stream';
				content: string;
				regenerate: boolean;
				attachments: ChatAttachment[];
		  }
		| {
				kind: 'toolApproval';
				token: string;
				approved: boolean;
		  }
		| {
				kind: 'askUser';
				answers: Record<string, string>;
		  }
		| {
				kind: 'edit';
				messageId: string;
				content: string;
		  };

	let retryIntent = $state<RetryIntent | null>(null);
	let retryBusy = $state(false);

	function logChatUi(level: 'info' | 'warn' | 'error', message: string, context: Record<string, unknown> = {}) {
		const payload = {
			at: new Date().toISOString(),
			conversationId,
			model,
			streaming,
			...context,
		};
		if (level === 'error') {
			console.error(`[chat/ui] ${message}`, payload);
			return;
		}
		if (level === 'warn') {
			console.warn(`[chat/ui] ${message}`, payload);
			return;
		}
		console.info(`[chat/ui] ${message}`, payload);
	}

	function setRecoverableError(message: string, nextRetryIntent: RetryIntent | null, context: Record<string, unknown> = {}) {
		streamError = message;
		retryIntent = nextRetryIntent;
		logChatUi('error', message, { recoverable: nextRetryIntent !== null, ...context });
	}

	function clearRecoverableError() {
		streamError = null;
		retryIntent = null;
	}

	async function retryLastAction() {
		if (!retryIntent || retryBusy) return;
		retryBusy = true;
		const intent = retryIntent;
		clearRecoverableError();
		logChatUi('info', 'Retry requested', { intent: intent.kind });
		try {
			if (intent.kind === 'stream') {
				await streamMessage(intent.content, intent.regenerate, intent.attachments);
				return;
			}
			if (intent.kind === 'toolApproval') {
				if (intent.approved) {
					await approveToolCall(intent.token);
				} else {
					await denyToolCall(intent.token);
				}
				return;
			}
			if (intent.kind === 'askUser') {
				await resolveAskUser(intent.answers);
				return;
			}
			await handleEdit(intent.messageId, intent.content);
		} catch {
			// Underlying handlers set the recoverable error and retry intent.
		} finally {
			retryBusy = false;
		}
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

	// Block-inspection helpers extracted to $lib/chat/streaming-blocks for unit-testability —
	// imported as getPartialText / getThinkingText / getLatestReasoningTokens /
	// getSerializableBlocksForMetadata / getCompletedToolCalls. Each takes streamingBlocks
	// as an argument instead of closing over it.

	async function persistPartialIfIncomplete() {
		// Persist any visible partial whenever the stream didn't complete with a `done` event
		// (i.e., `pendingMessageId` was never assigned). Covers user-stop AND error paths —
		// without this, the finally block wipes streamingBlocks and the partial vanishes.
		if (pendingMessageId) return;
		finalizeCurrentThinkingBlock();
		finalizeCurrentTextBlock();

		const textContent = getPartialText(streamingBlocks).trim();
		const thinkingContent = getThinkingText(streamingBlocks).trim();
		const contentToPersist = textContent || thinkingContent;
		if (!contentToPersist) return;

		await savePartialAssistant({
			conversationId,
			content: contentToPersist,
			model,
			toolCalls: getCompletedToolCalls(streamingBlocks),
			metadata: {
				partial: true,
				stoppedByUser,
				reasoningEffort,
				reasoningTokens: getLatestReasoningTokens(streamingBlocks),
				blocks: getSerializableBlocksForMetadata(streamingBlocks),
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

	$effect(() => {
		void loadAgentChoices();
	});

	const messages = $derived(conversationData?.messages ?? []);
	let agentChoices = $state<AgentChoice[]>([]);
	const conversationAgentId = $derived<string | null>(
		conversationData?.conversation.agentId ?? null,
	);

	async function loadAgentChoices() {
		try {
			agentChoices = await listAgentsForPicker();
		} catch (error) {
			logChatUi('warn', 'Agent picker load failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async function handleAgentChange(nextAgentId: string) {
		if (!conversationId || nextAgentId === conversationAgentId) return;
		try {
			await setConversationAgent({ conversationId, agentId: nextAgentId });
			// Optimistically reflect the new agent locally so the composer re-renders
			// immediately; loadConversationState refreshes the rest of the message list.
			if (conversationData) {
				conversationData = {
					...conversationData,
					conversation: { ...conversationData.conversation, agentId: nextAgentId },
				};
			}
			await getConversation(conversationId).refresh();
			await loadConversationState();
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Could not change agent'
			logChatUi('error', 'Agent switch failed', { error: message });
			// Surface the failure to the user instead of silently snapping the dropdown back.
			setRecoverableError(message, null, { action: 'handleAgentChange', nextAgentId });
		}
	}
	const initialPrompt = $derived(page.url.searchParams.get('prompt')?.trim() ?? '');
	// estimateTokens is imported from $lib/chat/streaming-blocks (chars / 4 fallback).
	const displayedMessages = $derived(
		buildDisplayedMessages({
			remoteMessages: messages,
			pendingUserMessages,
			pendingAssistantDrafts,
			model,
		}),
	);

	const lastUserMessageId = $derived.by(() => {
		for (let i = displayedMessages.length - 1; i >= 0; i -= 1) {
			if (displayedMessages[i].role === 'user') return displayedMessages[i].id;
		}
		return null;
	});

	const activeContextLimit = $derived.by(() => {
		const selected = availableModels.find((candidate) => candidate.id === model);
		return selected?.contextLength && selected.contextLength > 0 ? selected.contextLength : 128000;
	});
	const reservedResponsePct = $derived(appSettings?.contextConfig?.reservedResponsePct ?? 30);
	const autoCompactThresholdPct = $derived(appSettings?.contextConfig?.autoCompactThresholdPct ?? 72);

	const contextMetrics = $derived(
		computeContextMetrics({
			displayedMessages,
			stats,
			messages,
			totalBudget: activeContextLimit,
			liveTokenEstimate: liveContextStats?.tokenEstimate ?? null,
		}),
	);

	$effect(() => {
		if (conversationData?.conversation.model) {
			model = conversationData.conversation.model;
		}
	});

	$effect(() => {
		if (!browser) return;
		if (conversationId === reasoningHydratedFor) return;
		const stored = loadReasoningEffort(conversationId);
		if (stored) reasoningEffort = stored;
		reasoningHydratedFor = conversationId;
	});

	$effect(() => {
		if (!browser) return;
		if (reasoningHydratedFor !== conversationId) return;
		saveReasoningEffort(reasoningEffort, conversationId);
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
		const reconciled = reconcilePendingDrafts({
			pendingAssistantDrafts,
			pendingUserMessages,
			remoteMessages,
		});
		pendingAssistantDrafts = reconciled.pendingAssistantDrafts;
		pendingUserMessages = reconciled.pendingUserMessages;
	}

	async function loadConversationState() {
		if (!conversationId) {
			conversationData = null;
			stats = [];
			return;
		}

		// Invalidate the SvelteKit query cache before re-reading. Without these refresh
		// calls, the assistant message the server JUST persisted at the end of streaming
		// is missing from the returned payload (cache hit), so the streaming view
		// disappears (we already cleared streamingBlocks) before the new row arrives —
		// the user perceives this as messages getting wiped after the stream ends.
		await Promise.all([
			getConversation(conversationId).refresh(),
			getMessageStats(conversationId).refresh(),
		]);
		const [conversationResult, statsResult] = await Promise.all([
			getConversation(conversationId),
			getMessageStats(conversationId),
		]);
		conversationData = conversationResult;
		stats = statsResult;
		reconcilePendingWithRemote(conversationResult?.messages ?? []);
		// Reconcile pendingAskUser with the server's view: if mid-stream there's a live token
		// the SSE stream owns it and we don't touch it; otherwise (cold-load OR after a
		// disconnect that left a stale token), trust the server's un-decided entry — null
		// included, so a resolved/expired question clears the modal/HUD.
		if (!streaming) {
			pendingAskUser = conversationResult?.pendingAskUser
				? {
					token: conversationResult.pendingAskUser.token,
					questions: conversationResult.pendingAskUser.questions,
				}
				: null;
		}

	}

	async function refreshAll() {
		await loadConversationState();
	}

	function stopStreaming() {
		if (!streaming || !streamAbortController) return;
		finalizeCurrentThinkingBlock();
		finalizeCurrentTextBlock();
		stoppedByUser = true;
		streamAbortController.abort();
	}

	async function approveToolCall(token: string) {
		try {
			const response = await fetch(`/chat/${conversationId}/tool-approve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token, approved: true }),
			});
			if (!response.ok) {
				throw new Error(`Tool approval request failed with status ${response.status}`);
			}
			clearRecoverableError();
			streamingBlocks = streamingBlocks.map((b) =>
				b.kind === 'tool' && b.token === token ? { ...b, status: 'approved' as const } : b
			);
		} catch (error) {
			setRecoverableError(
				error instanceof Error ? error.message : 'Failed to approve tool call',
				{ kind: 'toolApproval', token, approved: true },
				{ token, action: 'approveToolCall' }
			);
			throw error;
		}
	}

	async function denyToolCall(token: string) {
		try {
			const response = await fetch(`/chat/${conversationId}/tool-approve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token, approved: false }),
			});
			if (!response.ok) {
				throw new Error(`Tool denial request failed with status ${response.status}`);
			}
			clearRecoverableError();
			streamingBlocks = streamingBlocks.map((b) =>
				b.kind === 'tool' && b.token === token ? { ...b, status: 'denied' as const } : b
			);
		} catch (error) {
			setRecoverableError(
				error instanceof Error ? error.message : 'Failed to deny tool call',
				{ kind: 'toolApproval', token, approved: false },
				{ token, action: 'denyToolCall' }
			);
			throw error;
		}
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
		try {
			const response = await fetch(`/chat/${conversationId}/ask-user`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token, answers }),
			});

			if (!response.ok) {
				throw new Error(`Failed to submit ask_user answers (status ${response.status})`);
			}

			clearRecoverableError();

			// ask_user answers should come from streamed/persisted assistant blocks only.
			// Do not create optimistic user bubbles for ask_user to avoid ordering/race issues.

			pendingAskUser = null;
			askUserModalOpen = false;
		} catch (error) {
			setRecoverableError(
				error instanceof Error ? error.message : 'Failed to submit ask_user answers',
				{ kind: 'askUser', answers },
				{ token, answerCount: Object.keys(answers).length, action: 'resolveAskUser' }
			);
			throw error;
		}
	}

	function closeAskUserModal() {
		askUserModalOpen = false;
	}

	function skipAskUserToChat() {
		askUserModalOpen = false;
	}

	async function handleComposerSubmit(content: string, attachments: ChatAttachment[]) {
		try {
			if (pendingAskUser) {
				const freeformAnswers = buildAskUserAnswersFromFreeform(content);
				if (Object.keys(freeformAnswers).length === 0) return;
				await resolveAskUser(freeformAnswers);
				return;
			}

			await streamMessage(content, false, attachments);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Could not send message'
			logChatUi('error', 'Composer submission failed', {
				error: message,
				attachmentCount: attachments.length,
			});
			setRecoverableError(message, null, { action: 'handleComposerSubmit' });
		}
	}

	// Wave 4 #18 phase 4 — Deep Research trigger from the chat composer.
	// Routes the textarea content through startResearchCommand instead of the chat stream
	// so the user gets a full multi-step research run (plan → search → fetch → synthesize)
	// linked back to the originating conversation. Navigates to /research/[id] so the user
	// sees the live trace immediately.
	async function handleResearchSubmit(content: string) {
		try {
			const { startResearchCommand } = await import('$lib/research/research.remote');
			const result = await startResearchCommand({
				query: content,
				conversationId: conversationId ?? undefined,
				// Pass the composer's selected model so the orchestrator's planner + reflection +
				// synthesizer all run on it (overrides DEFAULT_RESEARCH_CONFIG and per-agent config).
				model,
			});
			await goto(`/research/${result.research.id}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Research could not be started'
			logChatUi('error', 'Research submission failed', { error: message });
			setRecoverableError(message, null, { action: 'handleResearchSubmit' });
		}
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
		clearRecoverableError();
		streamingBlocks = [];
		currentTextTarget = '';
		currentThinkingTarget = '';
		stopDraftInterpolation();
		stopThinkingInterpolation();
		pendingMessageId = null;
		waitingForFirstToken = true;
		streamAbortController = abortController;
		stoppedByUser = false;
		liveContextStats = null;
		let streamHandshakeSucceeded = false;
		try {
			logChatUi('info', 'Opening stream', {
				regenerate,
				attachmentCount: attachments.length,
				reasoningEffort,
			});
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
				const responseText = await response.text().catch(() => '');
				throw new Error(
					`Failed to open stream (status ${response.status})${responseText ? `: ${responseText}` : ''}`
				);
			}

			streamHandshakeSucceeded = true;
			logChatUi('info', 'Stream opened', { regenerate });
			type ChunkReader = ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>;
			let reader: ChunkReader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let lastSeenSeq = 0;
			let doneReceived = false;
			let resumeAttempts = 0;
			const MAX_RESUME_ATTEMPTS = 3;

			const tryResume = async (): Promise<ChunkReader | null> => {
				if (doneReceived || stoppedByUser || resumeAttempts >= MAX_RESUME_ATTEMPTS) return null;
				resumeAttempts += 1;
				logChatUi('info', 'Attempting stream resume', { lastSeenSeq, attempt: resumeAttempts });
				try {
					const resumeResp = await fetch(
						`/chat/${conversationId}/stream/resume?since=${lastSeenSeq}`,
						{ signal: abortController.signal }
					);
					if (!resumeResp.ok || !resumeResp.body) {
						logChatUi('warn', 'Resume rejected', { status: resumeResp.status });
						return null;
					}
					return resumeResp.body.getReader();
				} catch (err) {
					logChatUi('warn', 'Resume request failed', {
						error: err instanceof Error ? err.message : String(err),
					});
					return null;
				}
			};

			while (true) {
				let chunk: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
				try {
					chunk = await reader.read();
				} catch (err) {
					if (err instanceof DOMException && err.name === 'AbortError') throw err;
					const next = await tryResume();
					if (!next) throw err;
					reader = next;
					buffer = '';
					continue;
				}
				if (chunk.done) {
					if (doneReceived || stoppedByUser) break;
					const next = await tryResume();
					if (!next) break;
					reader = next;
					buffer = '';
					continue;
				}
				buffer += decoder.decode(chunk.value, { stream: true });
				const events = buffer.split('\n\n');
				buffer = events.pop() ?? '';

				for (const raw of events) {
					// User clicked Stop — abort() rejects the next read() but events already
					// buffered will keep flowing through this loop. Don't mutate state any
					// further; the finally block will tear down cleanly.
					if (stoppedByUser) break;
					const lines = raw.split('\n');
					const idLine = lines.find((line) => line.startsWith('id: '));
					if (idLine) {
						const parsed = Number.parseInt(idLine.slice(4).trim(), 10);
						if (Number.isFinite(parsed) && parsed > lastSeenSeq) lastSeenSeq = parsed;
					}
					const eventLine = lines.find((line) => line.startsWith('event: '));
					const dataLine = lines.find((line) => line.startsWith('data: '));
					if (!eventLine || !dataLine) continue;

					const eventName = eventLine.slice(7).trim();
					let payload: Record<string, any>;
					try {
						payload = JSON.parse(dataLine.slice(6)) as Record<string, any>;
					} catch (error) {
						logChatUi('error', 'Failed to parse SSE payload', {
							eventName,
							rawData: dataLine.slice(6, 300),
							error: error instanceof Error ? error.message : String(error),
						});
						continue;
					}

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
						finalizeCurrentThinkingBlock();
						finalizeCurrentTextBlock();
						// Collapse any open thinking blocks while waiting for user input
						streamingBlocks = streamingBlocks.map((b) =>
							b.kind === 'thinking' ? { ...b, expanded: false } : b
						);
						// ask_user does not emit tool_pending/tool_call events, so create a
						// synthetic live tool block now to render the question immediately.
						const askUserArgs = JSON.stringify({ questions: payload.questions ?? [] });
						const existingAsk = streamingBlocks.find(
							(b) => b.kind === 'tool' && b.id === payload.id
						);
						if (!existingAsk && payload.id) {
							streamingBlocks = [
								...streamingBlocks.map((b) =>
									b.kind === 'tool' ? { ...b, expanded: false } : b
								),
								{
									kind: 'tool' as const,
									id: payload.id,
									name: payload.name ?? 'ask_user',
									arguments: askUserArgs,
									status: 'executing' as const,
									expanded: true,
									token: payload.token ?? null,
								},
							];
						}
						pendingAskUser = {
							token: payload.token,
							questions: payload.questions ?? []
						};
						// Phase 6 of #6: keep the modal CLOSED by default — the inline AskUserCard in
						// the chat stream is now the primary surface. The modal stays as an escape
						// hatch the user can open via the HUD's "Answer" button if they want the
						// stepper for multi-question flows.
						askUserModalOpen = false;
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
						const finalStatus = payload.success ? ('completed' as const) : ('failed' as const);
						const resultText =
							payload.result ?? (payload.success ? 'Success' : 'Tool execution failed');
						const idx = streamingBlocks.findIndex((b) => b.kind === 'tool' && b.id === payload.id);
						if (idx === -1) {
							// tool_result arrived without a matching tool_call/pending block. Append a
							// completed block so the result is still visible — better than the silent
							// drop the previous predicate produced when status didn't match.
							logChatUi('warn', 'tool_result without matching tool block', {
								id: payload.id,
								name: payload.name,
							});
							streamingBlocks = [
								...streamingBlocks.map((b) =>
									b.kind === 'tool' ? { ...b, expanded: false } :
									b.kind === 'thinking' ? { ...b, expanded: false } : b
								),
								{
									kind: 'tool' as const,
									id: payload.id,
									name: payload.name ?? 'unknown',
									arguments: '',
									status: finalStatus,
									expanded: true,
									token: null,
									executionMs: payload.executionMs ?? null,
									result: resultText,
								},
							];
						} else {
							const existing = streamingBlocks[idx];
							if (existing.kind === 'tool' && existing.status !== 'executing' && existing.status !== 'approved') {
								logChatUi('warn', 'tool_result for tool block in unexpected status', {
									id: payload.id,
									status: existing.status,
								});
							}
							streamingBlocks = streamingBlocks.map((b, i) =>
								i === idx && b.kind === 'tool'
									? {
											...b,
											status: finalStatus,
											executionMs: payload.executionMs ?? null,
											result: resultText,
										}
									: b
							);
						}
					}

					if (eventName === 'tool_denied') {
						streamingBlocks = applyToolDenied(streamingBlocks, payload.id);
					}

					if (eventName === 'subagent_start') {
						waitingForFirstToken = false;
						finalizeCurrentThinkingBlock();
						finalizeCurrentTextBlock();
						streamingBlocks = applySubagentStart(streamingBlocks, {
							agentId: payload.agentId,
							agentName: payload.agentName,
							conversationId: payload.conversationId,
							task: payload.task,
						});
					}

					if (eventName === 'subagent_delta') {
						streamingBlocks = applySubagentDelta(
							streamingBlocks,
							{ agentId: payload.agentId, conversationId: payload.conversationId },
							payload.content ?? '',
						);
					}

					if (eventName === 'subagent_tool_call') {
						streamingBlocks = applySubagentToolCall(
							streamingBlocks,
							{ agentId: payload.agentId, conversationId: payload.conversationId },
							payload.name,
						);
					}

					if (eventName === 'subagent_tool_result') {
						streamingBlocks = applySubagentToolResult(
							streamingBlocks,
							{ agentId: payload.agentId, conversationId: payload.conversationId },
							payload.name,
							payload.success,
						);
					}

					if (eventName === 'subagent_done') {
						streamingBlocks = applySubagentDone(streamingBlocks, {
							agentId: payload.agentId,
							conversationId: payload.conversationId,
						});
					}

					if (eventName === 'metrics') {
						updateLatestReasoningTokens(payload.reasoningTokens ?? null);
					}

					if (eventName === 'context_stats') {
						liveContextStats = {
							runId: typeof payload.runId === 'string' ? payload.runId : null,
							tokenEstimate: typeof payload.tokenEstimate === 'number' ? payload.tokenEstimate : null,
							contextWindow: typeof payload.contextWindow === 'number' ? payload.contextWindow : null,
							didCompact: Boolean(payload.didCompact),
							includedSlots: Array.isArray(payload.includedSlots) ? payload.includedSlots : [],
							droppedSlots: Array.isArray(payload.droppedSlots) ? payload.droppedSlots : [],
							truncatedSlots: Array.isArray(payload.truncatedSlots) ? payload.truncatedSlots : [],
							systemPromptTokens:
								typeof payload.systemPromptTokens === 'number' ? payload.systemPromptTokens : null,
						};
					}

					if (eventName === 'done') {
						doneReceived = true;
						waitingForFirstToken = false;
						if (payload.error) {
							const message = String(payload.error);
							setRecoverableError(
								message,
								{
									kind: 'stream',
									content,
									regenerate: regenerate || streamHandshakeSucceeded,
									attachments: regenerate || streamHandshakeSucceeded ? [] : attachments,
								},
								{ eventName: 'done', regenerate, streamHandshakeSucceeded }
							);
						} else if (payload.messageId) {
							clearRecoverableError();
							finalizeCurrentThinkingBlock();
							finalizeCurrentTextBlock();
							// Keep content visible until refreshAll() confirms DB message
							pendingMessageId = payload.messageId;
							const fullText = getPartialText(streamingBlocks);
							const completedToolCalls = getCompletedToolCalls(streamingBlocks);
							const hasAskUserTool = completedToolCalls.some(
								(call) => String(call.name ?? '') === 'ask_user'
							);
							if (!hasAskUserTool && (fullText.trim() || completedToolCalls.length > 0)) {
								pendingAssistantDrafts = [
									...pendingAssistantDrafts.filter((draft) => draft.id !== payload.messageId),
									{
										id: payload.messageId,
										content: fullText,
										createdAt: new Date(),
										toolCalls: completedToolCalls,
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
					setRecoverableError(
						'Stream interrupted',
						{
							kind: 'stream',
							content,
							regenerate: regenerate || streamHandshakeSucceeded,
							attachments: regenerate || streamHandshakeSucceeded ? [] : attachments,
						},
						{ regenerate, streamHandshakeSucceeded, reason: 'abort' }
					);
				}
			} else {
				setRecoverableError(
					error instanceof Error ? error.message : 'Streaming error',
					{
						kind: 'stream',
						content,
						regenerate: regenerate || streamHandshakeSucceeded,
						attachments: regenerate || streamHandshakeSucceeded ? [] : attachments,
					},
					{
						regenerate,
						streamHandshakeSucceeded,
						error: error instanceof Error ? error.message : String(error),
					}
				);
			}
		} finally {
			await persistPartialIfIncomplete().catch((error) => {
				logChatUi('warn', 'Failed to persist partial assistant message', {
					error: error instanceof Error ? error.message : String(error),
				});
			});

			// Always reload messages so user & assistant messages show even after an error
			await refreshAll().catch((error) => {
				logChatUi('warn', 'Failed to refresh chat state after stream', {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			// ask_user optimistic user bubbles are disabled, so no ask_user cleanup needed here.
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
				setRecoverableError(result?.error ?? 'Unable to edit message', { kind: 'edit', messageId, content }, { action: 'handleEdit' });
				return;
			}

			clearRecoverableError();
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
			setRecoverableError(
				error instanceof Error ? error.message : 'Unable to edit message',
				{ kind: 'edit', messageId, content },
				{ action: 'handleEdit', messageId }
			);
		}
	}

	async function handleRegenerate() {
		if (!conversationId || streaming) return;
		const pivotId = lastUserMessageId;
		if (!pivotId) return;
		try {
			const result = await deleteMessagesAfter({ conversationId, messageId: pivotId });
			if (!result || result.success !== true) {
				setRecoverableError(
					result?.error ?? 'Unable to regenerate response',
					{ kind: 'regenerate', messageId: pivotId },
					{ action: 'handleRegenerate', messageId: pivotId }
				);
				return;
			}
			clearRecoverableError();
			pendingAssistantDrafts = [];
			pendingMessageId = null;
			streamingBlocks = [];
			currentTextTarget = '';
			currentThinkingTarget = '';
			stopDraftInterpolation();
			stopThinkingInterpolation();
			await refreshAll();
			await streamMessage('regenerate', true);
		} catch (error) {
			setRecoverableError(
				error instanceof Error ? error.message : 'Unable to regenerate response',
				{ kind: 'regenerate', messageId: pivotId },
				{ action: 'handleRegenerate', messageId: pivotId }
			);
		}
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
		if (!conversationId || streaming) return;
		const compactionPrompt = `Please compact this conversation. Preserve all requirements, decisions, open tasks, constraints, and the latest user intent in a concise structured summary so we can continue from a smaller context.`;
		await streamMessage(compactionPrompt, false);
	}

	// Console-redesign — surface streaming/context data to the right rail.
	$effect(() => {
		consoleState.conversationId = conversationId || null;
		consoleState.conversationTitle = conversationData?.conversation.title ?? null;
	});

	$effect(() => {
		consoleState.streamingBlocks = streamingBlocks.map((b) => {
			if (b.kind === 'tool') {
				return {
					kind: 'tool',
					id: b.id,
					name: b.name,
					arguments: b.arguments,
					status: b.status,
					result: b.result,
					executionMs: b.executionMs ?? null,
				};
			}
			if (b.kind === 'thinking') {
				return { kind: 'thinking', id: b.id, content: b.content };
			}
			if (b.kind === 'text') {
				return { kind: 'text', id: b.id, content: b.content };
			}
			return {
				kind: 'subagent',
				id: b.id,
				agentName: b.agentName,
				task: b.task,
				status: b.status,
			};
		});

		const persisted = (conversationData?.messages ?? [])
			.flatMap((m) => Array.isArray((m as { toolCalls?: unknown[] }).toolCalls) ? (m as { toolCalls: Array<{ name?: string; success?: boolean }> }).toolCalls : [])
			.slice(-12)
			.reverse()
			.map((tc) => ({
				name: typeof tc.name === 'string' ? tc.name : 'tool',
				success: tc.success,
				ageMin: 0,
			}));
		consoleState.persistedToolCalls = persisted;
	});

	$effect(() => {
		const lc = liveContextStats;
		consoleState.liveContext = lc
			? {
					tokenEstimate: lc.tokenEstimate,
					contextWindow: lc.contextWindow,
					didCompact: lc.didCompact,
				}
			: null;
	});

	$effect(() => {
		const totalTokens = (stats ?? []).reduce((sum, s) => sum + (s.tokensIn ?? 0) + (s.tokensOut ?? 0), 0);
		const totalCost = (stats ?? []).reduce((sum, s) => sum + Number.parseFloat(s.cost ?? '0'), 0);
		consoleState.totalTokens = totalTokens;
		consoleState.totalCostUsd = totalCost;
		const ttftCandidate = (stats ?? []).filter((s) => typeof s.ttftMs === 'number').slice(-1)[0];
		consoleState.lastTtftMs = ttftCandidate?.ttftMs ?? null;
	});

	$effect(() => {
		const isStreaming = streaming || (pendingMessageId !== null);
		consoleState.runStatus = {
			state: isStreaming ? 'streaming' : 'idle',
			startedAt: isStreaming && consoleState.runStatus.startedAt === null
				? Date.now()
				: !isStreaming
					? null
					: consoleState.runStatus.startedAt,
			pendingApprovals: pendingAskUser ? 1 : 0,
		};
	});
</script>

<div class="flex min-h-0 min-w-0 w-full flex-1 gap-0 overflow-hidden">
	<section class="relative flex min-h-0 min-w-0 flex-1 flex-col gap-1 px-0 pt-0 pb-0 overflow-hidden desktop:px-1 desktop:pb-1">
		{#if !conversationData}
			<div class="flex flex-1 items-center justify-center">
				<span class="loading loading-spinner loading-sm opacity-50"></span>
			</div>
		{:else}

			<!-- Console topbar: breadcrumb + status chips + action icons (desktop) -->
			<div class="console-topbar hidden desktop:grid">
				<div class="console-crumbs">
					<span class="console-crumbs__cur">{conversationData.conversation.title}</span>
				</div>
				<div class="console-topbar__chips">
					{#if streaming}
						<span class="console-chip is-run">
							<span class="pulse-dot"></span>
							running
						</span>
					{/if}
					{#if pendingAskUser}
						<span class="console-chip is-warn">awaiting your input</span>
					{/if}
					{#if streamingBlocks.some((b) => b.kind === 'tool' && b.status === 'pending')}
						<span class="console-chip is-warn">{streamingBlocks.filter((b) => b.kind === 'tool' && b.status === 'pending').length} pending</span>
					{/if}
				</div>
			</div>

			<!-- Mobile/tablet header: Console design's am-top (menu | title+sub | actions) -->
			<div class="relative z-20 flex shrink-0 items-center gap-2 border-b border-base-300/50 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 desktop:hidden tablet:px-4 tablet:pt-2">
				<a href="/" class="console-iconbtn" aria-label="Back to chats" title="Back to chats" style="width:32px;height:32px;border:1px solid var(--color-base-300);">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
					</svg>
				</a>
				<div class="min-w-0 flex-1 text-center">
					<h1 class="m-0 truncate text-sm font-semibold leading-tight">
						{conversationData.conversation.title}
					</h1>
					{#if streaming}
						<span class="console-mobile-sub">
							<span class="pulse-dot"></span>
							running
						</span>
					{/if}
				</div>
				<ContextWindow
					used={contextMetrics.used}
					total={contextMetrics.total}
					breakdown={contextMetrics.breakdown}
					modelUsage={contextMetrics.modelUsage}
					reservedTargetPct={reservedResponsePct}
					onCompact={compactContext}
				/>
			</div>

			<!-- Mobile chips row: running, pending, context, cost -->
			<div class="console-mobile-chips">
				{#if streaming}
					<span class="console-chip is-run">
						<span class="pulse-dot" style="width:5px;height:5px;border-radius:999px;background:currentColor;display:inline-block;"></span>
						running
					</span>
				{/if}
				{#if streamingBlocks.some((b) => b.kind === 'tool' && b.status === 'pending')}
					<span class="console-chip is-warn">{streamingBlocks.filter((b) => b.kind === 'tool' && b.status === 'pending').length} pending</span>
				{/if}
				{#if contextMetrics.total > 0}
					<span class="console-chip">{(contextMetrics.used / 1000).toFixed(1)}K / {(contextMetrics.total / 1000).toFixed(0)}K</span>
				{/if}
				{#if conversationData.conversation.totalCost && Number.parseFloat(String(conversationData.conversation.totalCost)) > 0}
					<span class="console-chip">${Number.parseFloat(String(conversationData.conversation.totalCost)).toFixed(4)}</span>
				{/if}
			</div>

			{#if modelSwitchNotice}
				<div class="alert alert-info mt-1 mb-1 py-2 text-sm">
					<span>{modelSwitchNotice}</span>
				</div>
			{/if}

			<div bind:this={messagesEl} class="min-h-0 flex-1 overflow-y-auto px-2 py-2 tablet:px-4 tablet:py-3 desktop:px-4 desktop:py-2">
				<div class="w-full space-y-2">
				{#if displayedMessages.length === 0 && !streaming && !waitingForFirstToken}
					<div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-base-content/45">
						<svg class="size-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
						</svg>
						<p class="text-sm">Start the conversation by typing below.</p>
					</div>
				{/if}

				{#each displayedMessages as message (message.id)}
					<MessageBubble
						{message}
						onEdit={handleEdit}
						onRegenerate={handleRegenerate}
						canRegenerate={!streaming && message.id === lastUserMessageId}
					/>
				{/each}

				{#if waitingForFirstToken && streaming && streamingBlocks.length === 0}
					<div class="console-typing" role="status" aria-live="polite">
						<span class="console-typing__dots" aria-hidden="true">
							<span></span><span></span><span></span>
						</span>
						<span class="console-typing__label">Generating response</span>
					</div>
				{:else if streaming}
					{#each streamingBlocks as block (block.id)}
						{#if block.kind === 'tool' && block.name === 'ask_user'}
							{@const askQuestions = getAskUserQuestionsFromTool(block)}
							{@const askAnswers = getAskUserAnswersFromTool(block)}
							{@const askLive = block.status === 'pending' || block.status === 'approved' || block.status === 'executing'}
							{#if askQuestions.length > 0 && (askLive || (block.status === 'completed' && askAnswers))}
								<AskUserCard
									questions={askQuestions}
									status={block.status}
									answers={askAnswers}
									onSubmit={resolveAskUser}
								/>
							{/if}
						{:else if block.kind === 'tool' && block.name === 'present_artifact'}
							{@const card = getArtifactCardFromTool(block)}
							{#if card}
								<ArtifactCard {...card} />
							{/if}
						{:else if block.kind === 'tool' && block.name !== 'ask_user' && block.name !== 'present_artifact'}
							<ToolCallCard
								name={block.name}
								argumentsText={block.arguments}
								result={block.result ?? ''}
								status={block.status}
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
							<div class="assistant-message">
								<div class="markdown-body">{@html renderMarkdown(block.content)}</div>
							</div>
						{/if}
					{/each}
				{/if}
				</div>
			</div>

			{#if streamError}
				<div class="alert alert-error py-2 text-sm">
					<span>{streamError}</span>
					<div class="ml-auto flex items-center gap-2">
						{#if retryIntent}
							<button
								type="button"
								class="btn btn-xs btn-outline"
								onclick={retryLastAction}
								disabled={retryBusy || streaming}
							>
								{retryBusy ? 'Retrying...' : 'Retry'}
							</button>
						{/if}
						<button
							type="button"
							class="btn btn-xs btn-ghost"
							onclick={clearRecoverableError}
							disabled={retryBusy}
						>
							Dismiss
						</button>
					</div>
				</div>
			{/if}
		{/if}

		<!-- Mobile quick chips above composer -->
		<div class="console-quick">
			<button type="button"><Icon name="plus" size={12} /> Attach</button>
			<button type="button">@ Context</button>
			<button type="button">/ Commands</button>
		</div>

		<div class="chat-composer-transition w-full">

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
				agentId={conversationAgentId}
				agentChoices={agentChoices}
				onModelChange={(next) => maybeCompactBeforeModelSwitch(next)}
				onReasoningEffortChange={(next) => {
					reasoningEffort = next;
				}}
				onAgentChange={handleAgentChange}
				onSubmit={(content, attachments) => handleComposerSubmit(content, attachments)}
				estimatedRemaining={Math.max(0, contextMetrics.total - contextMetrics.used)}
			/>
		</div>
	</section>

</div>




