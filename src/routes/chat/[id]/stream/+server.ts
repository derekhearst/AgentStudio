import { json, type RequestHandler } from '@sveltejs/kit'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import { type LlmMessage } from '$lib/llm/chat.server'
import { generateTitle, shouldCompact, compactMessages, estimateMessageTokens } from '$lib/chat/chat.server'
import { getContextWindowSize } from '$lib/tools/tools'
import { emitActivity } from '$lib/activity/activity.server'
import { getToolDefinitions } from '$lib/tools/tools.server'
import { logLlmUsage } from '$lib/costs/usage'
import { checkBudgetLimits, recordBudgetAlert } from '$lib/costs/budget.server'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { listSkillSummaries, listRelevantSkillSummaries } from '$lib/skills/skills.server'
import { persistRunBlocks } from '$lib/runs/blocks.server'
import { trimHistoricalToolResults } from '$lib/chat/chat'
import { buildOrchestratorPrompt } from '$lib/agents/orchestrator'
import { runInlineSubagent } from '$lib/agents/inline-subagent'
import { recallForUser, renderMemoryContext } from '$lib/memory/memory.server'
import { assembleSystemPrompt, applySlotOverrides, type ContextSlot } from '$lib/context/slots.server'
import { loadSlotOverrides } from '$lib/context/overrides.server'
import { getModePostureContent } from '$lib/chat/mode.server'
import { runChatLoop, createSseSession } from '$lib/runtime'

const encoder = new TextEncoder()

const DREAMING_ONLY_TOOLS = new Set<string>()

type StreamPayload = {
	conversationId: string
	content?: string
	model?: string
	reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
	regenerate?: boolean
	attachments?: Array<{ id: string; filename: string; mimeType: string; size: number; url: string }>
}

type ChatRunState = (typeof chatRuns.$inferInsert)['state']

type LoopMessage = LlmMessage & {
	toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
	toolCallId?: string
}

type ReasoningDetail = {
	type?: string | null
	text?: string | null
	summary?: string | null
	data?: string | null
	[key: string]: unknown
}

function extractReasoningFragment(details: ReasoningDetail[] | undefined) {
	if (!details?.length) return ''

	return details
		.map((detail) => {
			switch (detail.type) {
				case 'reasoning.text':
					return typeof detail.text === 'string' ? detail.text : ''
				case 'reasoning.summary':
					return typeof detail.summary === 'string' ? detail.summary : ''
				case 'reasoning.encrypted':
					return '[Reasoning hidden by provider]'
				default:
					return typeof detail.text === 'string'
						? detail.text
						: typeof detail.summary === 'string'
							? detail.summary
							: ''
			}
		})
		.filter(Boolean)
		.join('\n\n')
}

function sse(name: string, payload: unknown, seq?: number) {
	const idLine = seq === undefined ? '' : `id: ${seq}\n`
	return encoder.encode(`${idLine}event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}
	const user = locals.user

	const body = (await request.json()) as StreamPayload
	if (!body.conversationId) {
		return json({ error: 'conversationId is required' }, { status: 400 })
	}

	const [conversation] = await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, body.conversationId), eq(conversations.userId, user.id)))
		.limit(1)

	if (!conversation) {
		return json({ error: 'Conversation not found' }, { status: 404 })
	}

	const currentSettings = await getOrCreateSettings(user.id)
	const selectedModel = body.model?.trim()
	const routedModel = selectedModel && selectedModel.length > 0 ? selectedModel : currentSettings.defaultModel
	const reasoningEffort = body.reasoningEffort ?? 'none'
	const reasoningConfig =
		reasoningEffort === 'none' ? undefined : { enabled: true, exclude: false, effort: reasoningEffort }
	const modelSelection = {
		source: selectedModel ? ('user' as const) : ('settingsDefault' as const),
		reason: selectedModel ? 'User-selected model' : 'Default model from settings',
	}
	let parentMessageId: string | null = null

	if (!body.regenerate) {
		if (!body.content || body.content.trim().length === 0) {
			return json({ error: 'content is required when regenerate=false' }, { status: 400 })
		}

		const [createdUser] = await db
			.insert(messages)
			.values({
				conversationId: body.conversationId,
				role: 'user',
				content: body.content.trim(),
				model: routedModel,
				metadata: {},
				toolCalls: [],
				attachments: body.attachments ?? [],
			})
			.returning()

		parentMessageId = createdUser.id
	} else {
		const [lastUser] = await db
			.select()
			.from(messages)
			.where(and(eq(messages.conversationId, body.conversationId), eq(messages.role, 'user')))
			.orderBy(desc(messages.createdAt))
			.limit(1)
		parentMessageId = lastUser?.id ?? null
	}

	const historyRows = await db
		.select({ role: messages.role, content: messages.content, attachments: messages.attachments })
		.from(messages)
		.where(eq(messages.conversationId, body.conversationId))
		.orderBy(asc(messages.createdAt))

	// First exchange = only the message we just inserted exists (historyRows has exactly 1 row)
	const isFirstExchange = historyRows.length === 1 && !body.regenerate

	if (isFirstExchange) {
		void emitActivity('chat_started', `Chat started: ${conversation.title}`, {
			entityId: body.conversationId,
			entityType: 'conversation',
		})
	}

	const llmMessages: LlmMessage[] = historyRows
		.filter((row) => row.role === 'system' || row.role === 'user' || row.role === 'assistant')
		.map((row) => {
			const imageAttachments = (row.attachments ?? []).filter((a) => a.mimeType.startsWith('image/'))
			if (imageAttachments.length > 0 && row.role === 'user') {
				return {
					role: row.role,
					content: [
						{ type: 'text' as const, text: row.content },
						...imageAttachments.map((a) => ({
							type: 'image_url' as const,
							image_url: { url: a.url },
						})),
					],
				}
			}
			return { role: row.role, content: row.content }
		})

	// --- Context Engineering: Unified System Prompt ---
	const toolConfig = currentSettings.toolConfig as
		| {
				approvalRequiredTools?: string[]
				approvalMode?: string
		  }
		| undefined
	const approvalRequiredTools = new Set(
		toolConfig?.approvalRequiredTools ?? (toolConfig?.approvalMode === 'confirm' ? ['*'] : []),
	)
	// Wave 5 #19 phase 3 finish — destructive source-control tools (push_branch /
	// create_pull_request) ALWAYS require operator approval, regardless of per-user
	// settings. Refused outright in non-interactive runs at the tool execution layer.
	const { MANDATORY_APPROVAL_TOOLS } = await import('$lib/tools/tools')
	for (const toolName of MANDATORY_APPROVAL_TOOLS) approvalRequiredTools.add(toolName)

	// Build skill summaries so the model can lazily load details with read_skill/read_skill_file.
	// Phase 4 of #4: filter by relevance to the user's query when available, capped to skillTopK
	// (default 8). Falls back to listing everything when no user content yet (e.g. regenerate
	// of a system-prompted run) or when embeddings are unavailable.
	const skillTopK = Math.max(
		1,
		((currentSettings.contextConfig as { skillTopK?: number } | null)?.skillTopK ?? 8),
	)
	let skillSummariesText: string | undefined
	const skillSummaries =
		body.content && body.content.trim().length > 0
			? await listRelevantSkillSummaries(body.content.trim(), skillTopK)
			: await listSkillSummaries()
	if (skillSummaries.length > 0) {
		skillSummariesText = skillSummaries
			.map((s) => {
				const fileNames = s.files.map((f) => f.name).join(', ')
				return `- ${s.name}: ${s.description}${fileNames ? ` [files: ${fileNames}]` : ''}`
			})
			.join('\n')
	}

	const contextSlots: ContextSlot[] = []
	let scopedAgentTools: string[] | null = null
	let persistentKey: string | null = null
	let worktreeConfig: { repoPath: string; baseBranch?: string; deleteBranchOnCleanup?: boolean } | null = null
	// Wave 2 #8 phase 4 — agent.config.capabilityGroups overrides the legacy "all tools" default
	// for non-orchestrator agents without an explicit allowedTools list. When set, the agent gets
	// progressive disclosure starting from these groups (instead of jumping straight to the full
	// surface). When unset, the legacy back-compat path is preserved.
	let agentCapabilityGroups: string[] | null = null

	// Wave 2 #8 phase 2 — pre-suggest capability groups from the user message so the model gets
	// the right tools on round 0 without spending a round calling enable_capability. Computed
	// here (before slot assembly) so the matching companion-skill summaries (Wave 2 #9 phase 3)
	// can be added as a context slot in the same pass.
	const isOrchestrator = !conversation.agentId
	const { suggestCapabilityGroups } = await import('$lib/tools/suggest-capabilities')
	const suggestedGroups = isOrchestrator && body.content ? suggestCapabilityGroups(body.content) : []

	// --- Context Engineering: Mode Posture (chat workbench mode) ---
	if (conversation.mode && conversation.mode !== 'chat') {
		contextSlots.push({
			name: `mode_${conversation.mode}`,
			priority: 95,
			content: await getModePostureContent(conversation.mode),
		})
	}

	// Wave 4 #15 phase 2 — project context slot. When the conversation is bound to a
	// project (via set_project_context), inject the project's name + slug + description so
	// the agent has continuous awareness of which project is "in scope" without needing to
	// call list_projects every turn. Priority 80 (between identity at 100 and skills at 70)
	// so it's high-signal but not above the agent's own role.
	if (conversation.projectId) {
		try {
			const { getProjectById } = await import('$lib/projects/projects.server')
			const project = await getProjectById(conversation.projectId)
			if (project && project.userId === user.id) {
				const description = project.description ? `\nDescription: ${project.description}` : ''
				contextSlots.push({
					name: 'project_context',
					priority: 80,
					content: `## Active project\n\nThe current conversation is bound to project "${project.name}" (kind=${project.kind}, slug=${project.slug}, id=${project.id}).${description}\n\nWhen using create_artifact, prefer this project's id unless the user specifies otherwise. Use list_artifacts({projectId: "${project.id}"}) to see existing work in this project, and read_artifact before edit_artifact.`,
				})
			}
		} catch (err) {
			console.warn('[chat] project context slot lookup failed', err)
		}
	}

	// --- Context Engineering: Orchestrator / Agent Identity ---
	if (isOrchestrator) {
		const orchestratorPrompt = await buildOrchestratorPrompt()
		contextSlots.push({ name: 'identity', priority: 100, content: orchestratorPrompt })
	} else {
		// Agent conversation — load agent's own system prompt.
		// Wave 5 #22 phase 2 — when agent.identitySkillId is set, prefer the skill's content
		// so /skills edits hot-reload without a deploy. Fall back to systemPrompt otherwise.
		const { agents: agentsTable } = await import('$lib/agents/agents.schema')
		const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, conversation.agentId!)).limit(1)
		if (agent) {
			let identityContent = agent.systemPrompt
			if (agent.identitySkillId) {
				try {
					const { skills: skillsTable } = await import('$lib/skills/skills.schema')
					const [skill] = await db
						.select({ content: skillsTable.content, enabled: skillsTable.enabled })
						.from(skillsTable)
						.where(eq(skillsTable.id, agent.identitySkillId))
						.limit(1)
					if (skill && skill.enabled && skill.content.trim().length > 0) {
						identityContent = skill.content
					}
				} catch (err) {
					console.warn('[chat] agent identity skill lookup failed, using systemPrompt fallback', err)
				}
			}
			// Wave 5 #22 phase 5 — expand `@import skill-name` fragments. Best-effort.
			try {
				const { expandFragments } = await import('$lib/agents/fragment-expand')
				const { skills: skillsTable } = await import('$lib/skills/skills.schema')
				identityContent = await expandFragments(identityContent, async (name) => {
					const [row] = await db
						.select({ content: skillsTable.content, enabled: skillsTable.enabled })
						.from(skillsTable)
						.where(eq(skillsTable.name, name))
						.limit(1)
					if (!row || !row.enabled) return null
					return row.content
				})
			} catch (err) {
				console.warn('[chat] fragment expansion failed, using raw identity content', err)
			}
			contextSlots.push({ name: 'identity', priority: 100, content: identityContent })
			const config = agent.config as
				| {
						allowedTools?: string[]
						capabilityGroups?: string[]
						workspace?: {
							mode?: string
							key?: string
							repoPath?: string
							baseBranch?: string
							deleteBranchOnCleanup?: boolean
						}
				  }
				| null
			if (Array.isArray(config?.allowedTools) && config.allowedTools.length > 0) {
				scopedAgentTools = config.allowedTools
			}
			if (Array.isArray(config?.capabilityGroups) && config.capabilityGroups.length > 0) {
				agentCapabilityGroups = config.capabilityGroups
			}
			// Phase 2 of #7: opt-in persistent workspace per agent.
			if (
				config?.workspace?.mode === 'persistent' &&
				typeof config.workspace.key === 'string' &&
				config.workspace.key.length > 0
			) {
				persistentKey = config.workspace.key
			}
			// Phase 4 of #7: opt-in git-worktree workspace per agent. The agent config supplies
			// the source repoPath; the worktree itself is created lazily on first tool use via
			// ensureWorkspace, off a `run/<runId>` branch from `baseBranch` (default: repo HEAD).
			if (
				config?.workspace?.mode === 'worktree' &&
				typeof config.workspace.repoPath === 'string' &&
				config.workspace.repoPath.length > 0
			) {
				worktreeConfig = {
					repoPath: config.workspace.repoPath,
					baseBranch: config.workspace.baseBranch,
					deleteBranchOnCleanup: config.workspace.deleteBranchOnCleanup,
				}
			}
		}
	}

	if (currentSettings.systemPrompt?.trim()) {
		// Reserved for optional future system prompt handling.
	}
	if (isOrchestrator) {
		contextSlots.push({
			name: 'tool_policy',
			priority: 90,
			content: [
				'Tool usage policy:',
				'- If the user asks you to ask questions, gather preferences with options, or confirm choices before continuing, you MUST call the ask_user tool.',
				"- Do not only say you'll ask a question in plain text when ask_user is appropriate.",
				'- Use concise questions with clear option labels, and allow freeform input when the request is open-ended.',
				'- For ask_user: aim for ~3 prefilled answer options per question. Prefer asking more focused questions (split complex choices across multiple questions) rather than listing many options in one question.',
				'',
				'Tool surface (progressive disclosure):',
				'- Only `core` capability tools are loaded by default. Other groups (`sandbox`, `skills`, `agents`, `media`) are gated behind the `enable_capability` meta-tool.',
				"- Call `enable_capability(group: '<name>')` once when the task clearly needs that group; the new tools become available on the NEXT round (not the same turn). Available groups: `sandbox` (file/shell/git tools), `skills` (manage reusable knowledge bundles), `agents` (delegate, schedule, manage), `media` (image generation).",
				"- Don't enable groups speculatively. Match what the user actually asked for.",
			].join('\n'),
		})
	} else {
		contextSlots.push({
			name: 'tool_policy',
			priority: 90,
			content: [
				'Tool usage policy:',
				'- You cannot call ask_user directly in agent conversations.',
				'- If you need user input, summarize missing information and return control to orchestrator for follow-up.',
				'',
				'Tool surface (progressive disclosure):',
				'- Only `core` capability tools are loaded by default. If you need filesystem/shell/git, skill management, sub-agent delegation, or image generation, call `enable_capability(group: \'sandbox\' | \'skills\' | \'agents\' | \'media\')` first; the tools become available on the NEXT round.',
			].join('\n'),
		})
	}
	if (skillSummariesText) {
		contextSlots.push({
			name: 'skills',
			priority: 70,
			content: `Available skills (use read_skill to load full content when relevant):\n${skillSummariesText}`,
			truncationStrategy: 'truncate-end',
		})
	}

	// Wave 2 #9 phase 3 — when capability groups are auto-suggested (or pre-bound on the agent),
	// surface their companion skill summaries in the context so the model knows when/how to use
	// the tools without waiting for an explicit enable_capability round-trip. Only the summaries
	// (not full bodies) — bodies still require read_skill.
	if (suggestedGroups.length > 0) {
		try {
			const { getCompanionSkillsForGroups } = await import('$lib/skills/skills.server')
			const companions = await getCompanionSkillsForGroups(suggestedGroups)
			if (companions.length > 0) {
				const lines = companions.map((s) => `- ${s.name}: ${s.description}`).join('\n')
				contextSlots.push({
					name: 'companion_skills',
					priority: 75,
					content: `Companion skills for the active capability groups (${suggestedGroups.join(', ')}). Call read_skill('<name>') to load full guidance:\n${lines}`,
					truncationStrategy: 'truncate-end',
				})
			}
		} catch (err) {
			console.warn('[skills] companion lookup for suggested groups failed', err)
		}
	}

	// --- Context Engineering: Memory Palace Recall ---
	const memoryConfig = (currentSettings.memoryConfig ?? null) as {
		enabled?: boolean
		topK?: number
		useRerank?: boolean
		rerankModel?: string
	} | null
	const memoryEnabled = memoryConfig?.enabled !== false
	if (memoryEnabled && body.content && body.content.trim().length > 0) {
		try {
			const recalled = await recallForUser(user.id, body.content.trim(), {
				topK: memoryConfig?.topK ?? 5,
				useRerank: memoryConfig?.useRerank ?? false,
				rerankModel: memoryConfig?.rerankModel,
			})
			const memoryBlock = renderMemoryContext(recalled)
			if (memoryBlock) {
				contextSlots.push({
					name: 'memory',
					priority: 60,
					content: memoryBlock,
					truncationStrategy: 'truncate-end',
				})
			}
		} catch (err) {
			console.warn('[memory] recall failed', err)
		}
	}

	// Phase 8 of #4: per-(user, agent) slot overrides. Lets users disable slots, raise/lower
	// priority, or set per-slot token caps from /agents/[id]/settings (UI follow-up).
	const slotOverrides = await loadSlotOverrides(user.id, conversation.agentId)
	const overriddenSlots = applySlotOverrides(contextSlots, slotOverrides)
	const assembled = assembleSystemPrompt(overriddenSlots)
	const capabilityPrompt = assembled.systemPrompt

	if (capabilityPrompt) {
		llmMessages.unshift({
			role: 'system',
			content: capabilityPrompt,
		})
	}

	// --- Context Engineering: Conversation Compaction ---
	const compactionCheck = await shouldCompact(llmMessages, routedModel, user.id)
	let didCompact = false
	if (compactionCheck.needed) {
		const result = await compactMessages(llmMessages, user.id, routedModel)
		if (result.summary) {
			llmMessages.length = 0
			llmMessages.push(...result.compacted)
			didCompact = true
		}
	}

	// --- Context Engineering: Trim Historical Tool Results ---
	const trimmedMessages = trimHistoricalToolResults(llmMessages)

	const startedAt = Date.now()

	// --- Context Engineering: Tool Loading (Wave 2 #8 phases 1 + 4 — progressive disclosure) ---
	// Resolution order:
	//   1. scopedAgentTools (agent.config.allowedTools) — explicit fixed surface, no PD.
	//   2. Orchestrator conversations OR agent conversations with agent.config.capabilityGroups —
	//      progressive disclosure starting at `core` (orchestrator) or the configured groups (agent).
	//   3. Agent conversations without allowedTools and without capabilityGroups — keep the legacy
	//      "all tools" surface so existing agents don't suddenly lose their toolkit.
	const { expandGroupsToToolNames, getEnabledGroups } = await import('$lib/tools/capabilities.server')
	const useProgressiveDisclosure = !scopedAgentTools && (isOrchestrator || agentCapabilityGroups !== null)
	// Pre-suggested groups (computed earlier so the slot pass could reference them) get merged
	// into the orchestrator's initial enabled set.
	const orchestratorBaseGroups = Array.from(new Set<string>(['core', ...suggestedGroups]))
	const initialEnabledGroups: string[] = isOrchestrator
		? orchestratorBaseGroups
		: (agentCapabilityGroups ?? ['core'])
	function computeToolsFor(enabledGroupNames: string[]) {
		const all = getToolDefinitions()
		const askUserFiltered = all.filter((tool) => (isOrchestrator ? true : tool.function.name !== 'ask_user'))
		if (scopedAgentTools) {
			return askUserFiltered.filter((tool) => scopedAgentTools!.includes(tool.function.name))
		}
		if (!useProgressiveDisclosure) {
			return askUserFiltered.filter((tool) => !DREAMING_ONLY_TOOLS.has(tool.function.name))
		}
		const activeNames = new Set(expandGroupsToToolNames(enabledGroupNames))
		return askUserFiltered
			.filter((tool) => !DREAMING_ONLY_TOOLS.has(tool.function.name))
			.filter((tool) => activeNames.has(tool.function.name))
	}
	const initialTools = computeToolsFor(initialEnabledGroups)
	// No hard limit — loop exits when the model stops calling tools
	const MAX_TOOL_ROUNDS = 50

	// Phase 3 of #5: budget enforcement BEFORE creating the run row, so a `block` cap
	// short-circuits without leaving an orphan run. Warnings are non-blocking and just
	// fire alert rows.
	const budgetCheck = await checkBudgetLimits({
		userId: user.id,
		agentId: conversation.agentId,
	})
	for (const w of budgetCheck.warnings) {
		try {
			await recordBudgetAlert({ limit: w.limit, triggerType: 'warn', spendUsd: w.spendUsd })
		} catch (err) {
			console.warn('[budget] warn alert insert failed', err)
		}
	}
	if (!budgetCheck.allowed && budgetCheck.blockedBy) {
		const blockedBy = budgetCheck.blockedBy
		// Await the alert write so callers querying budget_alerts immediately after the 402
		// response see the row (no fire-and-forget race).
		try {
			await recordBudgetAlert({
				limit: blockedBy,
				triggerType: 'block',
				spendUsd: parseFloat(blockedBy.limitUsd),
			})
		} catch (err) {
			console.warn('[budget] block alert insert failed', err)
		}
		// Wave 5 #20 — surface the block as a policy_override_request in the review inbox so
		// an operator can decide whether to lift the cap or hold it. Best-effort dynamic
		// import keeps the chat-stream path free of an observability cycle. DedupeKey
		// `budget:<limitId>:<userId>` collapses repeated denials into one open item.
		void (async () => {
			try {
				const { openReviewItem } = await import('$lib/observability/review.server')
				await openReviewItem({
					type: 'policy_override_request',
					severity: 'warning',
					summary: `Budget block: ${blockedBy.scope} ${blockedBy.period} limit of $${blockedBy.limitUsd} for user ${user.id.slice(0, 8)}`,
					payload: {
						kind: 'budget',
						limitId: blockedBy.id,
						scope: blockedBy.scope,
						scopeId: blockedBy.scopeId,
						period: blockedBy.period,
						limitUsd: blockedBy.limitUsd,
						userId: user.id,
						conversationId: body.conversationId,
					},
					sessionId: body.conversationId,
					dedupeKey: `budget:${blockedBy.id}:${user.id}`,
				})
			} catch (err) {
				console.warn('[budget] policy_override_request open failed', err)
			}
		})()
		return json(
			{
				error: 'budget_exceeded',
				message: `Budget cap exceeded: ${blockedBy.scope} ${blockedBy.period} limit of $${blockedBy.limitUsd}`,
				limitId: blockedBy.id,
			},
			{ status: 402 },
		)
	}

	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId: body.conversationId,
			userId: user.id,
			agentId: conversation.agentId,
			state: 'running',
			source: 'chat_stream',
			label: body.regenerate ? 'Regenerating response' : 'Generating response',
			startedAt: new Date(),
			lastHeartbeatAt: new Date(),
			// Seed the run with the initial capability groups (orchestrator → ['core'], agent →
			// agent.config.capabilityGroups). Subsequent enable_capability calls mutate this set.
			enabledCapabilityGroups: initialEnabledGroups,
		})
		.returning({ id: chatRuns.id, evalRequired: chatRuns.evalRequired })

	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			// Wave 2 #10 phase 1 — runtime extraction. The session wraps the controller +
			// run_events + chat_runs writes; the loop is now in $lib/runtime/loop.server.ts.
			const session = createSseSession({ runId: run.id, controller })

			try {
				// Notify client if compaction occurred
				if (didCompact) {
					await session.emit('compaction', { tokensBefore: compactionCheck.tokenEstimate })
				}

				// Phase 7 of #4: emit a context_stats snapshot so the chat workbench can show
				// the real prompt-assembly footprint (tokenizer-accurate) rather than estimating
				// client-side. Sent once at the top of the stream; cheap to compute.
				await session.emit('context_stats', {
					runId: run.id,
					tokenEstimate: estimateMessageTokens(trimmedMessages, routedModel),
					contextWindow: getContextWindowSize(routedModel),
					didCompact,
					includedSlots: assembled.includedSlots,
					droppedSlots: assembled.droppedSlots,
					truncatedSlots: assembled.truncatedSlots,
					systemPromptTokens: assembled.estimatedTokens,
				})

				const loopResult = await runChatLoop({
					session,
					userId: user.id,
					conversationId: body.conversationId,
					model: routedModel,
					initialMessages: trimmedMessages,
					initialTools,
					reasoningConfig,
					maxRounds: MAX_TOOL_ROUNDS,
					approvalRequiredTools,
					isOrchestrator,
					agentId: conversation.agentId ?? null,
					persistentKey,
					worktree: worktreeConfig,
					computeTools: useProgressiveDisclosure
						? async () => {
								const enabled = await getEnabledGroups(run.id)
								return computeToolsFor(enabled)
							}
						: async () => initialTools,
					spawnSubagent: async (req) => {
						const fullTask = req.context ? `${req.context}\n\n${req.task}` : req.task
						const result = await runInlineSubagent(
							{ agentId: req.agentId, agentName: req.agentId.slice(0, 8), task: fullTask },
							user.id,
							body.conversationId,
							session.safeController,
						)
						return { conversationId: result.conversationId, result: result.result }
					},
				})

				const {
					promptTokens,
					completionTokens,
					reasoningTokens,
					finalText: allTextContent,
					toolCalls: allToolCalls,
					streamBlocks,
				} = loopResult
				const firstTokenAt = loopResult.firstTokenAt

				const totalMs = Date.now() - startedAt
				const ttftMs = firstTokenAt
				const tokensPerSec = totalMs > 0 ? Math.round((completionTokens / (totalMs / 1000)) * 100) / 100 : null
				// Backfill the most recent thinking block with its final reasoning-token count.
				// The loop only learns the count from the LAST chunk; updating the block in-place
				// keeps the persisted metadata accurate after the message is saved.
				for (let i = streamBlocks.length - 1; i >= 0; i--) {
					const block = streamBlocks[i]
					if (block.kind === 'thinking') {
						block.reasoningTokens = reasoningTokens
						break
					}
				}
				await persistRunBlocks(run.id, streamBlocks)

				const messageCost = await logLlmUsage({
					source: 'chat',
					model: routedModel,
					tokensIn: promptTokens,
					tokensOut: completionTokens,
					userId: user.id,
					runId: run.id,
					agentId: conversation.agentId ?? null,
					metadata: { conversationId: body.conversationId },
				})

				const [assistantMessage] = await db
					.insert(messages)
					.values({
						conversationId: body.conversationId,
						role: 'assistant',
						content: allTextContent || '(no output)',
						model: routedModel,
						parentMessageId,
						tokensIn: promptTokens,
						tokensOut: completionTokens,
						ttftMs,
						totalMs,
						tokensPerSec,
						cost: messageCost,
						metadata: {
							modelSelection,
							reasoningEffort,
							reasoningTokens,
							blocks: streamBlocks.length > 0 ? streamBlocks : undefined,
						},
						toolCalls: allToolCalls,
					})
					.returning()

				await db
					.update(conversations)
					.set({
						model: routedModel,
						totalTokens: conversation.totalTokens + promptTokens + completionTokens,
						totalCost: String(parseFloat(conversation.totalCost) + parseFloat(messageCost)),
						updatedAt: new Date(),
					})
					.where(eq(conversations.id, body.conversationId))

				if (isFirstExchange && body.content) {
					void generateTitle([
						{ role: 'user', content: body.content.trim() },
						{ role: 'assistant', content: allTextContent },
					])
						.then((title) => db.update(conversations).set({ title }).where(eq(conversations.id, body.conversationId)))
						.catch(() => {
							// Non-critical — title stays as default
						})
				}

				await session.updateRun({
					state: 'completed',
					label: 'Completed',
					lastDelta: allTextContent.slice(-500),
					heartbeat: true,
					finished: true,
				})

				// --- Memory Palace: enqueue mining as a durable job ---
				// Wave 4 #17 phase 5: was a fire-and-forget `void mineConversation(...)`. Now
				// an enqueueJob with dedupeKey `mine:${conversationId}` so concurrent finishes
				// for the same convo collapse to one job, the work survives a restart, and
				// failures are visible in /settings/jobs instead of swallowed.
				const autoMine = (currentSettings.memoryConfig as { autoMine?: boolean } | null)?.autoMine !== false
				if (autoMine) {
					void (async () => {
						try {
							const { enqueueJob } = await import('$lib/jobs/jobs.server')
							await enqueueJob({
								type: 'memory_mine',
								queue: 'default',
								priority: 50, // background work — outranked by user-initiated jobs
								dedupeKey: `mine:${body.conversationId}`,
								payload: { conversationId: body.conversationId },
								userId: user.id,
								runId: run.id,
								sessionId: body.conversationId,
							})
						} catch (err) {
							console.warn('[memory] enqueue mine job failed', err)
						}
					})()
				}

				// Wave 4 #17 phase 5 — was a fire-and-forget `void runEvaluatorPass(...)`. Now an
				// enqueueJob with dedupeKey `eval:${runId}` so the work survives restart, fails
				// visibly in /settings/jobs, and dedupes if the trigger somehow fires twice. The
				// SSE `evaluation` event is dropped from this path — the verdict shows up in the
				// run viewer's Evaluations panel asynchronously when the worker finishes.
				if (run.evalRequired) {
					void (async () => {
						try {
							const { enqueueJob } = await import('$lib/jobs/jobs.server')
							const toolSummary = allToolCalls.length > 0
								? allToolCalls.map((c) => (c as { name?: string }).name).filter(Boolean).join(', ')
								: undefined
							await enqueueJob({
								type: 'evaluation_run',
								queue: 'default',
								priority: 75, // higher than memory_mine (50), lower than user-initiated (100+)
								dedupeKey: `eval:${run.id}`,
								payload: {
									runId: run.id,
									userId: user.id,
									conversationId: body.conversationId,
									taskDescription: body.content?.trim() ?? '(no user message)',
									generatorOutput: allTextContent,
									toolSummary,
								},
								userId: user.id,
								runId: run.id,
								sessionId: body.conversationId,
							})
						} catch (err) {
							console.warn('[evaluations] enqueue evaluation_run job failed', err)
						}
					})()
				}

				await session.emit('metrics', {
					model: routedModel,
					tokensIn: promptTokens,
					tokensOut: completionTokens,
					reasoningTokens,
					ttftMs,
					totalMs,
					tokensPerSec,
					cost: parseFloat(messageCost),
					modelSelection,
				})
				await session.emit('done', { messageId: assistantMessage.id })
				if (session.isClientConnected()) {
					controller.close()
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Failed to stream response'
				await session.updateRun({
					state: 'failed',
					label: 'Failed',
					error: errorMessage,
					finished: true,
				})
				await session.emit('done', {
					error: errorMessage,
				})
				if (session.isClientConnected()) {
					controller.close()
				}
			}
		},
	})

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	})
}
