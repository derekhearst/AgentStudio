<svelte:head><title>{conversationData?.conversation.title ?? 'Chat'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, tick } from 'svelte';
	import {
		deleteMessagesAfter,
		editMessage,
		getConversation,
		clearConversationTodoList,
		getMessageStats,
	} from '$lib/chat';
	import { savePartialAssistant, setConversationAgent, listAgentsForPicker } from '$lib/chat/chat.remote';

	type AgentChoice = Awaited<ReturnType<typeof listAgentsForPicker>>[number];
	import { getAvailableModels } from '$lib/llm';
	import { getSettings } from '$lib/settings';
	import ChatInput from '$lib/chat/ChatInput.svelte';
	import ContextWindow from '$lib/chat/ContextWindow.svelte';
	import { consoleState } from '$lib/chat-console/console-state.svelte';
	import { openLeft, openRight } from '$lib/chat-console/mobile-drawer-state.svelte';
	import Icon from '$lib/chat-console/Icon.svelte';
	import PinnedTodoPanel from '$lib/chat/PinnedTodoPanel.svelte';
	import type { TodoItem } from '$lib/engine/tool-result-details';
	import MessageBubble from '$lib/chat/MessageBubble.svelte';
	import ChatErrorNotice from '$lib/chat/ChatErrorNotice.svelte';
	import { shouldShowModelTag } from '$lib/chat/message-bubble-helpers';
	import ToolCallCard from '$lib/chat/ToolCallCard.svelte';
	import RunNoticeCard from '$lib/chat/RunNoticeCard.svelte';
	import FileEditCard from '$lib/chat/FileEditCard.svelte';
	import ShellOutputCard from '$lib/chat/ShellOutputCard.svelte';
	import TodoListCard from '$lib/chat/TodoListCard.svelte';
	import ThinkingBlockCard from '$lib/chat/ThinkingBlockCard.svelte';
	import AskUserModal from '$lib/chat/AskUserModal.svelte';
	import AskUserCard from '$lib/chat/AskUserCard.svelte';
	import SubagentBlockCard from '$lib/chat/SubagentBlockCard.svelte';
	import PermissionModeSelect from '$lib/chat/PermissionModeSelect.svelte';
	import { renderMarkdown } from '$lib/chat/chat';
	import {
		parseJsonFallback,
		getAskUserQuestionsFromTool,
		getAskUserAnswersFromTool,
		type AskUserOption,
		type AskUserQuestion,
	} from '$lib/chat/tool-block-helpers';
	import {
		appendThinking,
		applyAskUser,
		applyAskUserAnswered,
		applyDeltaStart,
		applySubagentDelta,
		applySubagentDone,
		applySubagentStart,
		applySubagentToolCall,
		applySubagentToolResult,
		applyNotice,
		applyToolCall,
		applyToolDenied,
		applyToolPending,
		applyToolProgress,
		applyToolResult,
		buildDisplayedMessages,
		estimateTokens,
		finalizeText,
		finalizeThinking,
		getCompletedToolCalls,
		getLatestReasoningTokens,
		getPartialText,
		getSerializableBlocksForMetadata,
		getThinkingText,
		reconcilePendingDrafts,
		setLatestReasoningTokens,
		type StreamingBlock,
		type TextBlock,
		type ThinkingBlock,
		type ToolStatus,
	} from '$lib/chat/streaming-blocks';
	import {
		hasUnfinishedInterpolation,
		stepDraftFrame,
		stepThinkingFrame,
	} from '$lib/chat/streaming-interpolation';
	import { consumeSseStream } from '$lib/chat/sse-consumer';
	import { approvalAnswerProblem, askUserAnswerProblem, requestRunStop, stopTaskProblem } from '$lib/chat/run-controls';
	import { computeContextMetrics } from '$lib/chat/context-metrics';
	import { dropPromptParam, takeHandedOffAttachments } from '$lib/chat/new-chat-handoff';

	type ChatAttachment = {
		id: string;
		filename: string;
		mimeType: string;
		size: number;
		url: string;
	};

	import { loadReasoningEffort, saveReasoningEffort, type ReasoningEffort } from '$lib/chat/reasoning-effort';

	const conversationId = $derived(page.params.id ?? '');
	let model = $state('claude-sonnet-5');
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
	/**
	 * Live background tasks, from the SDK's `background_tasks_changed` frame.
	 *
	 * REPLACE semantics — each frame carries the whole live set, so this is assigned, never
	 * merged. Cleared when a turn starts and again when its stream ends, because the set
	 * belongs to the run.
	 */
	let backgroundTasks = $state<Array<{ id: string; type: string; description: string }>>([]);
	/** Monotonic, because the transcript's `{#each}` is keyed and duplicate keys throw. */
	let noticeSeq = 0;
	/**
	 * #21 — the pinned checklist. Seeded from the conversation on load and replaced by the
	 * `todo_list` frame while a run streams, so the panel is right on a cold open and right
	 * mid-turn without the two paths disagreeing. `null` means dismissed or never written.
	 */
	let todoList = $state<{ items: TodoItem[]; updatedAt: string } | null>(null);
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
		  }
		| {
				kind: 'regenerate';
				messageId: string;
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
			if (intent.kind === 'regenerate') {
				await handleRegenerate();
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

	// Typewriter-interpolation rAF loops. The pure stepping logic lives in
	// `streaming-interpolation.ts`; the page just owns the frame handles and
	// drives requestAnimationFrame.
	function interpolateThinking(now: number) {
		thinkingInterpolationFrame = null;
		if (thinkingInterpolationLastTs === null) thinkingInterpolationLastTs = now;
		const elapsedMs = now - thinkingInterpolationLastTs;
		thinkingInterpolationLastTs = now;
		const frame = stepThinkingFrame(streamingBlocks, currentThinkingTarget, elapsedMs);
		if (frame.blocks) streamingBlocks = frame.blocks;
		if (frame.done) stopThinkingInterpolation();
		else thinkingInterpolationFrame = requestAnimationFrame(interpolateThinking);
	}

	function queueThinkingInterpolation() {
		if (thinkingInterpolationFrame !== null) return;
		if (!hasUnfinishedInterpolation(streamingBlocks, 'thinking', currentThinkingTarget)) return;
		thinkingInterpolationFrame = requestAnimationFrame(interpolateThinking);
	}

	function interpolateDraft(now: number) {
		draftInterpolationFrame = null;
		if (draftInterpolationLastTs === null) draftInterpolationLastTs = now;
		const elapsedMs = now - draftInterpolationLastTs;
		draftInterpolationLastTs = now;
		const frame = stepDraftFrame(streamingBlocks, currentTextTarget, elapsedMs);
		if (frame.blocks) streamingBlocks = frame.blocks;
		if (frame.done) stopDraftInterpolation();
		else draftInterpolationFrame = requestAnimationFrame(interpolateDraft);
	}

	function queueDraftInterpolation() {
		if (draftInterpolationFrame !== null) return;
		if (!hasUnfinishedInterpolation(streamingBlocks, 'text', currentTextTarget)) return;
		draftInterpolationFrame = requestAnimationFrame(interpolateDraft);
	}

	function appendThinkingContent(content: string) {
		const next = appendThinking(streamingBlocks, currentThinkingTarget, content);
		streamingBlocks = next.blocks;
		currentThinkingTarget = next.target;
		queueThinkingInterpolation();
	}

	function updateLatestReasoningTokens(reasoningTokens: number | null | undefined) {
		streamingBlocks = setLatestReasoningTokens(streamingBlocks, reasoningTokens);
	}

	/** Commit currentTextTarget into the last text block and stop animation. */
	function finalizeCurrentTextBlock() {
		stopDraftInterpolation();
		if (!currentTextTarget) return;
		streamingBlocks = finalizeText(streamingBlocks, currentTextTarget);
		currentTextTarget = '';
	}

	function finalizeCurrentThinkingBlock() {
		stopThinkingInterpolation();
		if (!currentThinkingTarget) return;
		streamingBlocks = finalizeThinking(streamingBlocks, currentThinkingTarget);
		currentThinkingTarget = '';
	}

	// Block-inspection helpers extracted to $lib/chat/streaming-blocks for unit-testability —
	// imported as getPartialText / getThinkingText / getLatestReasoningTokens /
	// getSerializableBlocksForMetadata / getCompletedToolCalls. Each takes streamingBlocks
	// as an argument instead of closing over it.

	async function persistPartialIfIncomplete(runConversationId: string) {
		// Persist any visible partial whenever the stream didn't complete with a `done` event
		// (i.e., `pendingMessageId` was never assigned). Covers user-stop AND error paths —
		// without this, the finally block wipes streamingBlocks and the partial vanishes.
		// Into the conversation the stream belongs to, which the caller captured when it began.
		if (pendingMessageId) return;
		finalizeCurrentThinkingBlock();
		finalizeCurrentTextBlock();

		const textContent = getPartialText(streamingBlocks).trim();
		const thinkingContent = getThinkingText(streamingBlocks).trim();
		const contentToPersist = textContent || thinkingContent;
		if (!contentToPersist) return;

		await savePartialAssistant({
			conversationId: runConversationId,
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
					: b.kind === 'notice'
						? `${b.id}:${b.notice.kind}`
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

	/**
	 * True once this page has gone — another conversation opened (the chat/[id] layout
	 * remounts the page per id, #74) or another page entirely. Leaving is not a Stop: the run
	 * carries on and saves its own reply, and coming back re-attaches to it. So the stream is
	 * let go of, and nothing it was doing may still write a partial, refresh or navigate.
	 */
	let leftPage = false;
	onDestroy(() => {
		leftPage = true;
		streamAbortController?.abort();
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
			systemPromptTokens: liveContextStats?.systemPromptTokens ?? null,
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

	/*
	 * The first message handed over by the page that created this conversation (#75, #59).
	 * Only once the conversation has loaded — `messages` is empty until then, so the "already
	 * sent" check never fired and a reload sent the prompt again. And the prompt leaves the
	 * URL and the history entry before it is sent, not after the reply ends: a reload, a
	 * restored tab or a Back to this page must not repeat it, and a navigation at the end of
	 * the reply pulled the user off whatever page they had moved on to.
	 */
	$effect(() => {
		const prompt = initialPrompt;
		if (!prompt || consumedInitialPrompt || !conversationId || !conversationData) return;
		consumedInitialPrompt = true;
		const attachments = takeHandedOffAttachments(conversationId);
		void dropPromptParam(page.url, page.state)
			.catch((error) => logChatUi('warn', 'Could not take the prompt out of the URL', { error: String(error) }))
			.then(() => {
				if (leftPage) return;
				// Already sent: the conversation has messages, or a turn is running (re-attached to below).
				if (messages.length > 0 || pendingUserMessages.length > 0) return;
				if (streaming || conversationData?.liveRunId) return;
				void streamMessage(prompt, false, attachments);
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
		// #21 — re-seed the pinned checklist from the row. The stream owns it while a run is
		// live; this is the cold-open and post-run value, and it is authoritative because a
		// dismissal cleared the column too.
		const storedTodos = conversationResult?.conversation.todoList ?? null;
		todoList = storedTodos ? { items: storedTodos.items, updatedAt: storedTodos.updatedAt } : null;
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

			/*
			 * Open the modal on a cold load, because nothing else can.
			 *
			 * The inline AskUserCard lives in `streamingBlocks`, which only exist for the
			 * tab that watched the stream. After a refresh those are gone and the question
			 * survives only in `chat_runs.pending_questions`, reconstructed just above.
			 * The modal was the documented escape hatch — "the user can open it via the
			 * HUD's Answer button" — but RunHud.svelte is no longer rendered anywhere, so
			 * `askUserModalOpen` had no remaining path to `true` and a paused question was
			 * simply unanswerable: the run waits forever and the operator has no control
			 * that resolves it.
			 */
			if (pendingAskUser && streamingBlocks.length === 0) {
				askUserModalOpen = true;
			}
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
		// Dropping the connection alone no longer stops the run (a reload must not), so say so.
		void requestRunStop(conversationId, liveContextStats?.runId ?? attachedRunId);
		streamAbortController.abort();
	}

	/**
	 * #21 — dismiss the pinned checklist.
	 *
	 * Cleared locally first so the panel goes away on click rather than on a round trip, and
	 * the column is cleared too: without that, the next cold open would pin it right back.
	 * A failed clear leaves the panel hidden for this view and the row untouched, which
	 * reappears on reload — the honest outcome, and not worth an error toast over.
	 */
	async function dismissTodoList() {
		todoList = null;
		try {
			await clearConversationTodoList(conversationId);
			await getConversation(conversationId).refresh();
		} catch (error) {
			console.warn('[chat] failed to clear the checklist', error);
		}
	}

	/** Task ids a stop has been sent for, so the button cannot be double-fired. */
	let stoppingTasks = $state<string[]>([]);
	/** Why the last background-task stop did not work, shown briefly under the header. */
	let backgroundTaskNotice = $state<string | null>(null);

	/**
	 * #35 — stop one background task.
	 *
	 * The model can already background a command; until now nothing could stop one. The run
	 * id comes from `context_stats`, which the stream emits before any task can exist, so a
	 * visible task always has one. The chip is left in place on failure rather than removed
	 * optimistically: `background_tasks_changed` is the authority on what is live, and it
	 * arrives on its own the moment the task actually goes away. The exception is an answer
	 * that the turn has already ended, which took the task with it. Either way a refusal is
	 * shown rather than swallowed.
	 */
	async function stopBackgroundTask(taskId: string) {
		const runId = liveContextStats?.runId;
		if (!runId || stoppingTasks.includes(taskId)) return;
		stoppingTasks = [...stoppingTasks, taskId];
		let problem: ReturnType<typeof stopTaskProblem> = null;
		try {
			const response = await fetch(`/chat/${conversationId}/stop-task`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ runId, taskId })
			});
			problem = stopTaskProblem(response.ok, await response.json().catch(() => null));
		} catch (error) {
			console.warn('[chat] failed to stop a background task', error);
			problem = stopTaskProblem(false, null);
		} finally {
			stoppingTasks = stoppingTasks.filter((id) => id !== taskId);
		}
		if (problem) {
			if (problem.taskGone) backgroundTasks = backgroundTasks.filter((task) => task.id !== taskId);
			const message = problem.message;
			backgroundTaskNotice = message;
			setTimeout(() => {
				if (backgroundTaskNotice === message) backgroundTaskNotice = null;
			}, 5000);
		}
	}

	async function approveToolCall(token: string) {
		try {
			const response = await fetch(`/chat/${conversationId}/tool-approve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token, approved: true }),
			});
			const problem = approvalAnswerProblem(response.ok, response.status, await response.json().catch(() => null));
			if (problem) throw new Error(problem);
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
			const problem = approvalAnswerProblem(response.ok, response.status, await response.json().catch(() => null));
			if (problem) throw new Error(problem);
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

			// #83 — a 200 is not an answer: `resolved: false` means it went nowhere.
			const problem = askUserAnswerProblem(response.ok, response.status, await response.json().catch(() => null));
			if (problem?.gone) {
				// Nothing to retry. Say so, and let the server's view replace the stale question.
				setRecoverableError(problem.message, null, { token, action: 'resolveAskUser' });
				if (!streaming) await refreshAll();
				return;
			}
			if (problem) throw new Error(problem.message);

			clearRecoverableError();

			// ask_user answers should come from streamed/persisted assistant blocks only.
			// Do not create optimistic user bubbles for ask_user to avoid ordering/race issues.
			// The card itself shows the recorded answers (#81).
			streamingBlocks = applyAskUserAnswered(streamingBlocks, token, answers);

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

	/**
	 * Run one turn and stream it — or, with `attachRunId`, follow a turn already running (#129):
	 * a reloaded page, or a send refused because a turn was in progress. Attaching replays the
	 * run's saved frames from the start through `stream/resume` and then follows it live, so
	 * its tool cards, approvals and Stop button are back. Text written before the attach is
	 * not in the replay; it arrives with the saved reply when the turn ends.
	 */
	async function streamMessage(
		content: string,
		regenerate = false,
		attachments: ChatAttachment[] = [],
		attachRunId: string | null = null,
	) {
		if (!conversationId || streaming) return;
		const runConversationId = conversationId;

		const abortController = new AbortController();
		const startedAt = new Date();
		const optimisticUserId = `pending-user-${startedAt.getTime()}`;
		/** Set when the send was refused because this turn is already running. */
		let busyRunId: string | null = null;
		attachedRunId = attachRunId;
		if (!regenerate && !attachRunId) {
			pendingUserMessages = [
				...pendingUserMessages,
				{ id: optimisticUserId, content: content.trim(), createdAt: startedAt }
			];
		}

		streaming = true;
		// An attach is automatic; it must not hide why the user's own send was refused.
		if (!attachRunId) clearRecoverableError();
		streamingBlocks = [];
		currentTextTarget = '';
		currentThinkingTarget = '';
		stopDraftInterpolation();
		stopThinkingInterpolation();
		pendingMessageId = null;
		waitingForFirstToken = true;
		streamAbortController = abortController;
		stoppedByUser = false;
		backgroundTasks = [];
		liveContextStats = null;
		let streamHandshakeSucceeded = false;
		/** What Retry does after a failure. Nothing, for an attach: there is no send to repeat. */
		const retryIntentFor = (): RetryIntent | null =>
			attachRunId
				? null
				: {
						kind: 'stream',
						content,
						regenerate: regenerate || streamHandshakeSucceeded,
						attachments: regenerate || streamHandshakeSucceeded ? [] : attachments,
					};
		try {
			logChatUi('info', attachRunId ? 'Attaching to a running turn' : 'Opening stream', {
				attachRunId,
				regenerate,
				attachmentCount: attachments.length,
				reasoningEffort,
			});
			const resumeUrl = (since: number) => {
				const runId = attachRunId ?? liveContextStats?.runId ?? null;
				return `/chat/${conversationId}/stream/resume?since=${since}${runId ? `&runId=${runId}` : ''}`;
			};
			const response = attachRunId
				? await fetch(resumeUrl(0), { signal: abortController.signal })
				: await fetch(`/chat/${conversationId}/stream`, {
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

			if (response.status === 409) {
				// A turn is already running here — started in another tab, or before a reload.
				const conflict = await response.json().catch(() => null);
				busyRunId = typeof conflict?.runId === 'string' ? conflict.runId : null;
				pendingUserMessages = pendingUserMessages.filter((message) => message.id !== optimisticUserId);
				throw new Error('A turn is already running in this conversation, so this message was not sent. Send it again once that turn finishes.');
			}

			if (!response.ok || !response.body) {
				const responseText = await response.text().catch(() => '');
				throw new Error(
					`Failed to open stream (status ${response.status})${responseText ? `: ${responseText}` : ''}`
				);
			}

			streamHandshakeSucceeded = true;
			logChatUi('info', 'Stream opened', { regenerate });
			let doneReceived = false;

			for await (const sseEvent of consumeSseStream({
				initialResponse: response,
				fetchResume: (since) => fetch(resumeUrl(since), { signal: abortController.signal }),
				shouldStop: () => doneReceived || stoppedByUser || leftPage,
				onResumeAttempt: (info) => logChatUi('info', 'Attempting stream resume', info),
				onResumeRejected: (info) => logChatUi('warn', 'Resume rejected', info),
				onResumeError: (err) =>
					logChatUi('warn', 'Resume request failed', {
						error: err instanceof Error ? err.message : String(err),
					}),
				onParseError: (info) =>
					logChatUi('error', 'Failed to parse SSE payload', {
						eventName: info.eventName,
						rawData: info.rawData,
						error: info.error instanceof Error ? info.error.message : String(info.error),
					}),
			})) {
				const eventName = sseEvent.event;
				const payload = sseEvent.payload as Record<string, any>;
				{
					if (eventName === 'delta') {
						waitingForFirstToken = false;
						finalizeCurrentThinkingBlock();
						streamingBlocks = applyDeltaStart(streamingBlocks);
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
						streamingBlocks = applyToolPending(streamingBlocks, payload as Parameters<typeof applyToolPending>[1]);
					}

					if (eventName === 'ask_user') {
						waitingForFirstToken = false;
						finalizeCurrentThinkingBlock();
						finalizeCurrentTextBlock();
						streamingBlocks = applyAskUser(streamingBlocks, payload as Parameters<typeof applyAskUser>[1]);
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
						const existing = streamingBlocks.some((b) => b.kind === 'tool' && b.id === payload.id);
						if (!existing) {
							// Auto-approve mode — tool_call arrives without a prior pending block.
							finalizeCurrentThinkingBlock();
							finalizeCurrentTextBlock();
						}
						streamingBlocks = applyToolCall(streamingBlocks, payload as Parameters<typeof applyToolCall>[1]);
					}

					if (eventName === 'tool_result') {
						if (payload.name === 'ask_user') {
							pendingAskUser = null;
							askUserModalOpen = false;
						}
						const outcome = applyToolResult(streamingBlocks, payload as Parameters<typeof applyToolResult>[1]);
						if (outcome.missing) {
							logChatUi('warn', 'tool_result without matching tool block', {
								id: payload.id,
								name: payload.name,
							});
						} else if (outcome.unexpectedStatus) {
							logChatUi('warn', 'tool_result for tool block in unexpected status', {
								id: payload.id,
								status: outcome.unexpectedStatus,
							});
						}
						streamingBlocks = outcome.blocks;
					}

					if (eventName === 'tool_denied') {
						streamingBlocks = applyToolDenied(streamingBlocks, payload.id);
					}

					if (eventName === 'notice' && payload?.title) {
						waitingForFirstToken = false;
						finalizeCurrentThinkingBlock();
						finalizeCurrentTextBlock();
						streamingBlocks = applyNotice(
							streamingBlocks,
							payload as Parameters<typeof applyNotice>[1],
							`notice-${++noticeSeq}`
						);
					}

					if (eventName === 'tool_progress') {
						streamingBlocks = applyToolProgress(streamingBlocks, {
							id: payload.id,
							elapsedSeconds: payload.elapsedSeconds ?? 0,
						});
					}

					if (eventName === 'todo_list') {
						// #21 — the agent rewrote its plan. Replace, never merge: `TodoWrite`
						// sends the whole list every time, and a merge would resurrect an item
						// the model deliberately dropped.
						todoList = Array.isArray(payload?.items)
							? {
									items: payload.items as TodoItem[],
									updatedAt:
										typeof payload.updatedAt === 'string'
											? payload.updatedAt
											: new Date().toISOString()
								}
							: null;
					}

					if (eventName === 'background_tasks') {
						backgroundTasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
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
						if (typeof payload.runId === 'string') watchedRunIds.add(payload.runId);
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
								retryIntentFor(),
								{ eventName: 'done', regenerate, streamHandshakeSucceeded }
							);
						}
						// A saved reply, even one that ended in an error (max turns, an overloaded
						// API): its id is what stops the finally block saving a partial copy of it
						// as a second assistant message (#76).
						if (payload.messageId) {
							if (!payload.error) clearRecoverableError();
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
				if (!stoppedByUser && !leftPage) {
					setRecoverableError(
						'Stream interrupted',
						retryIntentFor(),
						{ regenerate, streamHandshakeSucceeded, reason: 'abort' }
					);
				}
			} else {
				setRecoverableError(
					error instanceof Error ? error.message : 'Streaming error',
					retryIntentFor(),
					{
						regenerate,
						streamHandshakeSucceeded,
						error: error instanceof Error ? error.message : String(error),
					}
				);
			}
		} finally {
			// The page is gone (#74): the run saves its own reply, and there is nothing to show.
			if (!leftPage) {
				await persistPartialIfIncomplete(runConversationId).catch((error) => {
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
			}
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
			// The chips belong to the run this page was watching. It has ended, or is no longer
			// reporting here, and the run's end closes the session that owned the tasks — a chip
			// left behind would pulse, and offer a stop, for a process that is gone.
			backgroundTasks = [];
			stoppingTasks = [];
			streamingBlocks = [];
			currentTextTarget = '';
			currentThinkingTarget = '';
			stopDraftInterpolation();
			stopThinkingInterpolation();
			attachedRunId = null;
			if (busyRunId && !leftPage) attachToRun(busyRunId);
		}
	}

	/** Runs this page has streamed or attached to — each is attached at most once. */
	const watchedRunIds = new Set<string>();
	/** The run an attach is following, so Stop can name it before its first frame arrives. */
	let attachedRunId: string | null = null;

	/** Follow a turn that is running without this page watching it (#129). */
	function attachToRun(runId: string) {
		if (streaming || watchedRunIds.has(runId)) return;
		watchedRunIds.add(runId);
		void streamMessage('', false, [], runId);
	}

	// A turn still running when the page loads — a reload, or a return to the conversation.
	$effect(() => {
		const runId = conversationData?.liveRunId ?? null;
		if (runId && !streaming) attachToRun(runId);
	});

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
		consoleState.streamingBlocks = streamingBlocks.flatMap((b) => {
			// Notices are run-level events, not activity — the rail lists what the agent did.
			if (b.kind === 'notice') return [];
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

	// The rail shows the same figure as the header's meter (#78): the stream's own estimate is
	// the system prompt alone, which read as a nearly empty context from the first turn on.
	$effect(() => {
		consoleState.liveContext = conversationData
			? {
					tokenEstimate: contextMetrics.used,
					contextWindow: contextMetrics.total,
					didCompact: liveContextStats?.didCompact ?? false,
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

	/*
	 * Deliberately not `$state`: this is read only by the effect below, which also writes
	 * it. The previous version kept the run's start time on `consoleState.runStatus` and
	 * read it back to decide whether to keep or reset it — so the effect depended on the
	 * object it assigned, and since it assigns a fresh object every time it re-triggered
	 * itself until Svelte gave up with `effect_update_depth_exceeded` and tore down
	 * reactivity for the subtree. Any page that reached a chat hit it; /agents/new, which
	 * redirects straight into one, raised it eighteen times on a single load.
	 */
	let runStartedAt: number | null = null;

	$effect(() => {
		const isStreaming = streaming || pendingMessageId !== null;
		if (!isStreaming) runStartedAt = null;
		else runStartedAt ??= Date.now();

		consoleState.runStatus = {
			state: isStreaming ? 'streaming' : 'idle',
			startedAt: runStartedAt,
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
					<!-- #19: the active permission mode, always visible so a session left on bypass is obvious. -->
					<PermissionModeSelect
						conversationId={conversationData.conversation.id}
						permissionMode={conversationData.conversation.permissionMode}
						disabled={streaming}
						onChange={(next) => {
							if (conversationData) conversationData.conversation.permissionMode = next;
						}}
					/>
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
					{#each backgroundTasks as task (task.id)}
						<span class="console-bgtask" title={`${task.description} (${task.type})`}>
							<span class="pulse-dot"></span>
							<span>{task.description}</span>
							<button
								type="button"
								class="console-bgtask__stop"
								title="Stop this background task"
								aria-label={`Stop background task: ${task.description}`}
								disabled={stoppingTasks.includes(task.id)}
								onclick={() => stopBackgroundTask(task.id)}
							>
								<Icon name="x" size={10} />
							</button>
						</span>
					{/each}
				</div>
			</div>

			<!-- Mobile/tablet header: Console design's am-top (menu | title+sub | actions) -->
			<div class="relative z-20 flex shrink-0 items-center gap-2 border-b border-base-300/50 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 desktop:hidden tablet:px-4 tablet:pt-2">
				<button type="button" onclick={openLeft} class="console-iconbtn" aria-label="Open navigation" title="Menu" style="width:32px;height:32px;border:1px solid var(--color-base-300);">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M4 6h16M4 12h16M4 18h16" />
					</svg>
				</button>
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
				<button type="button" onclick={openRight} class="console-iconbtn" aria-label="Open chat rail" title="Open rail" style="width:32px;height:32px;border:1px solid var(--color-base-300);">
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<rect x="3" y="4" width="18" height="16" rx="2" />
						<line x1="15" y1="4" x2="15" y2="20" />
					</svg>
				</button>
			</div>

			<!-- Mobile chips row: permission mode, running, pending, context, cost -->
			<div class="console-mobile-chips">
				<PermissionModeSelect
					conversationId={conversationData.conversation.id}
					permissionMode={conversationData.conversation.permissionMode}
					disabled={streaming}
					onChange={(next) => {
						if (conversationData) conversationData.conversation.permissionMode = next;
					}}
				/>
				{#if streaming}
					<span class="console-chip is-run">
						<span class="pulse-dot" style="width:5px;height:5px;border-radius:999px;background:currentColor;display:inline-block;"></span>
						running
					</span>
				{/if}
				{#if streamingBlocks.some((b) => b.kind === 'tool' && b.status === 'pending')}
					<span class="console-chip is-warn">{streamingBlocks.filter((b) => b.kind === 'tool' && b.status === 'pending').length} pending</span>
				{/if}
				{#each backgroundTasks as task (task.id)}
					<span class="console-bgtask" title={`${task.description} (${task.type})`}>
						<span class="pulse-dot"></span>
						<span>{task.description}</span>
						<button
							type="button"
							class="console-bgtask__stop"
							title="Stop this background task"
							aria-label={`Stop background task: ${task.description}`}
							disabled={stoppingTasks.includes(task.id)}
							onclick={() => stopBackgroundTask(task.id)}
						>
							<Icon name="x" size={10} />
						</button>
					</span>
				{/each}
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
			{#if backgroundTaskNotice}
				<div class="alert alert-warning mt-1 mb-1 py-2 text-sm" role="status" data-testid="background-task-notice">
					<span>{backgroundTaskNotice}</span>
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

				{#each displayedMessages as message, i (message.id)}
					<MessageBubble
						{message}
						onEdit={handleEdit}
						onRegenerate={handleRegenerate}
						canRegenerate={!streaming && message.id === lastUserMessageId}
						modelChanged={shouldShowModelTag(displayedMessages, i)}
					/>
				{/each}

				{#if waitingForFirstToken && streaming && streamingBlocks.length === 0}
					<div class="console-typing" role="status" aria-live="polite">
						<span class="console-typing__dots" aria-hidden="true">
							<span></span><span></span><span></span>
						</span>
						<span class="console-typing__label">Generating response</span>
					</div>
				<!--
					Stop rendering the live stream as soon as `done` hands us the message
					id. At that point the same content already exists as a pending
					assistant draft in displayedMessages, but `streaming` stays true until
					the finally block, which waits on refreshAll() — so both rendered and
					the reply flashed twice. Handing off here keeps it seamless: the draft
					is already on screen, so there is no gap either.
				-->
				{:else if streaming && !pendingMessageId}
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
						<!--
							#16 / #26 / #21 — once the result carries a shape we know, the block graduates
							from the generic card to the one that renders it. `details` only ever arrives
							with the result, so a still-pending call keeps ToolCallCard and its
							Allow/Deny controls.
						-->
						{:else if block.kind === 'tool' && block.details?.kind === 'file_edit'}
							<FileEditCard details={block.details} success={block.status !== 'failed'} />
						{:else if block.kind === 'tool' && block.details?.kind === 'shell'}
							<ShellOutputCard details={block.details} success={block.status !== 'failed'} />
						{:else if block.kind === 'tool' && block.details?.kind === 'todo'}
							<TodoListCard details={block.details} />
						{:else if block.kind === 'notice'}
							<RunNoticeCard notice={block.notice} />
						{:else if block.kind === 'tool' && block.name !== 'ask_user'}
							<ToolCallCard
								name={block.name}
								argumentsText={block.arguments}
								result={block.result ?? ''}
								status={block.status}
								executionMs={block.executionMs ?? null}
								elapsedSeconds={block.elapsedSeconds ?? null}
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
				<ChatErrorNotice
					message={streamError}
					canRetry={Boolean(retryIntent)}
					retrying={retryBusy}
					busy={retryBusy || streaming}
					onRetry={retryLastAction}
					onDismiss={clearRecoverableError}
				/>
			{/if}
		{/if}

		{#if todoList}
			<PinnedTodoPanel
				items={todoList.items}
				updatedAt={todoList.updatedAt}
				onDismiss={dismissTodoList}
			/>
		{/if}

		<!-- Mobile quick chips above composer -->
		<div class="console-quick">
			<button type="button"><Icon name="plus" size={12} /> Attach</button>
			<button type="button">@ Context</button>
			<button type="button">/ Commands</button>
		</div>

		<div class="chat-composer-transition w-full">

			<!--
				Only mount the modal when a question is actually pending.

				Mounting it unconditionally froze the page on every send: it was fed
				`pendingAskUser?.questions ?? []`, a freshly allocated array on each
				update, which kept its derived chain re-running and blew the effect
				update depth (`effect_update_depth_exceeded`). Svelte then tore down
				reactivity for the subtree, so the stream spinner never resolved and
				navigation stopped working — with no pending question in sight.
			-->
			{#if pendingAskUser}
				<AskUserModal
					open={askUserModalOpen}
					questions={pendingAskUser.questions}
					onSubmit={resolveAskUser}
					onClose={closeAskUserModal}
					onSkipToChat={skipAskUserToChat}
				/>
			{/if}

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




