/**
 * The models the chat engine can actually run, for the engine's model pickers (#9).
 *
 * The chat composer, the agent editor and the default-model setting used to offer OpenRouter's
 * whole catalogue. Every one of those models except Claude needs the gateway, so on a
 * deployment without one, picking any of them failed on the first message. And picking a
 * Claude row from the catalogue stored OpenRouter's spelling (`anthropic/claude-haiku-4.5`),
 * which the CLI does not know.
 *
 * So the engine list is built here instead:
 *
 * - **Subscription rows** — the catalogue's Anthropic models, under the CLI's id
 *   (`claude-haiku-4-5`). Catalogue variants (`:thinking`, `:beta`) are left out: they name an
 *   OpenRouter routing mode, not a model the CLI can be asked for. Reasoning has its own
 *   control in the composer.
 * - **Gateway rows** — only when the gateway is configured, and only the models the gateway
 *   itself says it serves. Priced from the OpenRouter catalogue when the id is in it; a model
 *   only the gateway knows (a local model behind LiteLLM, say) is listed unpriced.
 * - **Pinned ids** — the saved default model, so it can be picked again even while the
 *   catalogue is unreachable. Only if something here can run it.
 *
 * Pure, so a spec can check the rules without a network.
 */

import type { ModelInfo } from '$lib/llm/models.server'
import { isClaudeModel, modelBackend, normalizeModelId } from '$lib/engine/model-backend'

export type EngineModelBackend = 'subscription' | 'gateway'

export type EngineModel = ModelInfo & {
	backend: EngineModelBackend
	/** False for a gateway model the OpenRouter catalogue has no price for. */
	priced: boolean
}

export type EngineModelList = {
	gatewayConfigured: boolean
	models: EngineModel[]
}

/** An OpenRouter variant suffix: `anthropic/claude-3.7-sonnet:thinking`. */
const VARIANT_SUFFIX = /:[^/]*$/

function bareEntry(id: string, backend: EngineModelBackend): EngineModel {
	return {
		id,
		name: id,
		description: null,
		contextLength: null,
		promptPrice: '0',
		completionPrice: '0',
		backend,
		priced: backend === 'subscription',
	}
}

export function buildEngineModelList(input: {
	catalogue: readonly ModelInfo[]
	gatewayConfigured: boolean
	/** What the gateway says it serves; null when it could not be asked. */
	gatewayModelIds: readonly string[] | null
	/** Ids to offer whatever the catalogue says, as long as they can run here. */
	pinned?: readonly string[]
}): EngineModel[] {
	const out = new Map<string, EngineModel>()

	for (const model of input.catalogue) {
		if (!isClaudeModel(model.id) || VARIANT_SUFFIX.test(model.id)) continue
		const id = normalizeModelId(model.id)
		if (out.has(id)) continue
		out.set(id, { ...model, id, backend: 'subscription', priced: true })
	}

	if (input.gatewayConfigured && input.gatewayModelIds) {
		const byId = new Map(input.catalogue.map((model) => [model.id, model]))
		for (const raw of input.gatewayModelIds) {
			const id = raw.trim()
			// A Claude model always runs on the subscription, never through the paid gateway.
			if (!id || isClaudeModel(id) || out.has(id)) continue
			const catalogued = byId.get(id)
			out.set(id, catalogued ? { ...catalogued, backend: 'gateway', priced: true } : bareEntry(id, 'gateway'))
		}
	}

	for (const raw of input.pinned ?? []) {
		if (!raw?.trim()) continue
		const backend = modelBackend(raw, { gatewayConfigured: input.gatewayConfigured })
		if (backend === 'unavailable') continue
		const id = backend === 'subscription' ? normalizeModelId(raw) : raw.trim()
		if (!out.has(id)) out.set(id, bareEntry(id, backend))
	}

	return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The row for `value` in an engine list, matching however the stored id is spelled. */
export function findEngineModel<T extends { id: string }>(models: readonly T[], value: string): T | undefined {
	const id = normalizeModelId(value)
	return models.find((model) => model.id === id)
}

/**
 * The ids in a gateway's `GET /v1/models` answer — OpenAI's `{ data: [{ id }] }` shape, which
 * OpenRouter and LiteLLM both use. Anything malformed is skipped rather than trusted.
 */
export function parseGatewayModelIds(body: unknown): string[] {
	const data = (body as { data?: unknown } | null)?.data
	if (!Array.isArray(data)) return []
	const ids = new Set<string>()
	for (const entry of data) {
		const id = (entry as { id?: unknown } | null)?.id
		if (typeof id === 'string' && id.trim().length > 0) ids.add(id.trim())
	}
	return [...ids]
}
