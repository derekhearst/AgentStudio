import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { skills } from '$lib/skills/skills.schema'
import { chat, type LlmMessage } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import { hookInvocations } from './hooks.schema'
import type { HookEvent, HookPayload } from './types'
import { logger } from '$lib/observability/logger'

/**
 * Wave 3 #13 phase 3 — skill-based hook runner.
 *
 * When an agent's `config.hooks[event]` array contains a ref that doesn't match a globally
 * registered built-in handler, the bus delegates to this module. We look up the skill by
 * `name = ref` (skills' name column has a unique index, so this is fast). If the skill exists
 * and is enabled, we execute it as a single-shot LLM call: system prompt = skill content,
 * user message = JSON-serialized hook payload. The output is purely observational — the run
 * never blocks on it, and the result is logged into `hook_invocations` with `hookKind='skill'`
 * so the admin dashboard can surface what skill ran when, what it cost, and how long it took.
 *
 * Single-shot synthesis (`chat()`) instead of `runChatLoop` keeps skill hooks cheap and
 * bounded. If a future use case needs tool access from a hook, swap in a detached Session +
 * runChatLoop here behind a per-skill flag.
 */

const DEFAULT_HOOK_MODEL = 'openai/gpt-4o-mini'
const DEFAULT_HOOK_TIMEOUT_MS = 8000

export type RunSkillHookInput<E extends HookEvent = HookEvent> = {
	event: E
	skillName: string
	payload: HookPayload<E>
	timeoutMs?: number
}

export type RunSkillHookResult = {
	success: boolean
	durationMs: number
	error: string | null
	skillFound: boolean
	output?: string
}

export async function runSkillHook<E extends HookEvent>(
	input: RunSkillHookInput<E>,
): Promise<RunSkillHookResult> {
	const startedAt = Date.now()
	const runId = (input.payload as { runId?: string | null }).runId ?? null
	const userId = (input.payload as { userId?: string | null }).userId ?? null

	// 1. Look up the skill. If missing or disabled, log a structured failure and bail.
	const [skill] = await db
		.select({ id: skills.id, name: skills.name, content: skills.content, enabled: skills.enabled })
		.from(skills)
		.where(eq(skills.name, input.skillName))
		.limit(1)

	if (!skill || !skill.enabled) {
		const errorMsg = !skill
			? `skill "${input.skillName}" not found`
			: `skill "${input.skillName}" is disabled`
		await logSkillHookInvocation({
			runId,
			event: input.event,
			skillName: input.skillName,
			success: false,
			durationMs: Date.now() - startedAt,
			error: errorMsg,
		})
		return {
			success: false,
			durationMs: Date.now() - startedAt,
			error: errorMsg,
			skillFound: !!skill,
		}
	}

	// 2. Execute as a single-shot LLM call with the payload serialized into the user message.
	const messages: LlmMessage[] = [
		{ role: 'system', content: skill.content },
		{
			role: 'user',
			content: `Hook event: ${input.event}\n\nPayload:\n\`\`\`json\n${safeStringify(input.payload)}\n\`\`\``,
		},
	]

	const timeoutMs = input.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
	let output = ''
	let usage: { promptTokens?: number; completionTokens?: number } | undefined
	let err: string | null = null

	try {
		const result = await Promise.race([
			chat(messages, DEFAULT_HOOK_MODEL),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error(`skill hook "${input.skillName}" timed out after ${timeoutMs}ms`)),
					timeoutMs,
				),
			),
		])
		output = result.content
		usage = result.usage
	} catch (e) {
		err = e instanceof Error ? e.message : String(e)
	}

	const durationMs = Date.now() - startedAt

	// 3. Log cost (best-effort) and the invocation outcome.
	if (usage && userId) {
		await logLlmUsage({
			source: 'evaluator',
			model: DEFAULT_HOOK_MODEL,
			tokensIn: usage.promptTokens ?? 0,
			tokensOut: usage.completionTokens ?? 0,
			userId,
			runId: runId ?? null,
			metadata: { hookEvent: input.event, hookSkill: input.skillName },
		}).catch(() => '0')
	}

	await logSkillHookInvocation({
		runId,
		event: input.event,
		skillName: input.skillName,
		success: err === null,
		durationMs,
		error: err,
	})

	return {
		success: err === null,
		durationMs,
		error: err,
		skillFound: true,
		output: err === null ? output : undefined,
	}
}

async function logSkillHookInvocation(input: {
	runId: string | null
	event: HookEvent
	skillName: string
	success: boolean
	durationMs: number
	error: string | null
}) {
	try {
		await db.insert(hookInvocations).values({
			runId: input.runId,
			event: input.event,
			hookKind: 'skill',
			hookRef: input.skillName,
			success: input.success,
			durationMs: input.durationMs,
			error: input.error,
		})
	} catch (e) {
		logger.warn('[hooks/skill-runner] failed to log invocation', {
			event: input.event,
			skillName: input.skillName,
			error: e instanceof Error ? e.message : String(e),
		})
	}
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2).slice(0, 4000)
	} catch {
		return String(value).slice(0, 4000)
	}
}
