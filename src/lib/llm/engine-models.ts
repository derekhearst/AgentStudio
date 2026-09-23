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
 * - **Subscription rows** — the Claude models the bundled CLI can run
 *   (`SUBSCRIPTION_MODEL_IDS` in `$lib/engine/model-backend`), under the CLI's id
 *   (`claude-haiku-4-5`). The OpenRouter catalogue only describes them (context window,
 *   modalities, description) and never adds one: it still lists retired Claude models, some
 *   under slugs that are not Anthropic ids at all (`anthropic/claude-sonnet-4`), and the CLI
 *   would refuse those on the first message. Every subscription model is offered whether or
 *   not the catalogue can be reached, since running one does not involve OpenRouter.
 * - **Gateway rows** — only when the gateway is configured, and only the models the gateway
 *   itself says it serves. Priced from the OpenRouter catalogue when the id is in it. The CLI
 *   sends tools on every request, so a catalogued model that does not take them, or does not
 *   answer in text, is left out: it would fail on the first message. A model only the gateway
 *   knows (a local model behind LiteLLM, say) is listed unpriced.
 * - **Pinned ids** — the saved default model, so it can be picked again even when nothing
 *   else lists it: a CLI alias (`opus`), a snapshot id, or a gateway model while the gateway's
 *   own list is unreachable. Only if something here can run it.
 *
 * Pure, so a spec can check the rules without a network.
 */

import type { ModelInfo } from '$lib/llm/models.server'
import { isClaudeModel, modelBackend, normalizeModelId, SUBSCRIPTION_MODEL_IDS } from '$lib/engine/model-backend'

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

/**
 * `claude-haiku-4-5` → `Claude Haiku 4.5`, `claude-fable-5-1` → `Claude Fable 5.1`: the name a
 * subscription row is listed under, the same whether or not the catalogue has the model.
 */
export function claudeDisplayName(id: string): string {
	const words = id.replace(/^claude-/i, '').split('-')
	const firstVersion = words.findIndex((word) => /^\d/.test(word))
	const family = firstVersion === -1 ? words : words.slice(0, firstVersion)
	const version = firstVersion === -1 ? '' : ` ${words.slice(firstVersion).join('.')}`
	return `Claude ${family.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}${version}`
}

/** What every subscription model takes in and gives back, for a row the catalogue lacks. */
const SUBSCRIPTION_INPUT_MODALITIES = ['text', 'image', 'file']
const SUBSCRIPTION_OUTPUT_MODALITIES = ['text']

/**
 * Whether the gateway can run a model the catalogue describes. The CLI sends tools on every
 * request and reads a text answer, so a catalogued model has to take tools and answer in
 * text. A model the catalogue does not list is the gateway's own, and nothing says otherwise.
 */
function gatewayCanRun(catalogued: ModelInfo | undefined): boolean {
	if (!catalogued) return true
	return (catalogued.supportedParameters ?? []).includes('tools') && (catalogued.outputModalities ?? []).includes('text')
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
	const byId = new Map(input.catalogue.map((model) => [model.id, model]))

	// The catalogue's description of each Claude model, keyed by the CLI's id for it. A variant
	// (`:thinking`, `:beta`) names an OpenRouter routing mode, not a model, so it describes
	// nothing here; reasoning has its own control in the composer.
	const claudeCatalogue = new Map<string, ModelInfo>()
	for (const model of input.catalogue) {
		if (!isClaudeModel(model.id) || VARIANT_SUFFIX.test(model.id)) continue
		const id = normalizeModelId(model.id)
		if (!claudeCatalogue.has(id)) claudeCatalogue.set(id, model)
	}

	for (const id of SUBSCRIPTION_MODEL_IDS) {
		const catalogued = claudeCatalogue.get(id)
		out.set(id, {
			...(catalogued ?? bareEntry(id, 'subscription')),
			inputModalities: catalogued?.inputModalities?.length ? catalogued.inputModalities : SUBSCRIPTION_INPUT_MODALITIES,
			outputModalities: catalogued?.outputModalities?.length ? catalogued.outputModalities : SUBSCRIPTION_OUTPUT_MODALITIES,
			id,
			name: claudeDisplayName(id),
			backend: 'subscription',
			priced: true,
		})
	}

	if (input.gatewayConfigured && input.gatewayModelIds) {
		for (const raw of input.gatewayModelIds) {
			const id = raw.trim()
			// A Claude model always runs on the subscription, never through the paid gateway.
			if (!id || isClaudeModel(id) || out.has(id)) continue
			const catalogued = byId.get(id)
			if (!gatewayCanRun(catalogued)) continue
			out.set(id, catalogued ? { ...catalogued, backend: 'gateway', priced: true } : bareEntry(id, 'gateway'))
		}
	}

	for (const raw of input.pinned ?? []) {
		if (!raw?.trim()) continue
		const backend = modelBackend(raw, { gatewayConfigured: input.gatewayConfigured })
		if (backend === 'unavailable') continue
		const id = backend === 'subscription' ? normalizeModelId(raw) : raw.trim()
		if (backend === 'gateway' && !gatewayCanRun(byId.get(id))) continue
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
