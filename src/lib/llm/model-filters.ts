/**
 * Pure model-list filtering, sorting, and grouping for the ModelSelector
 * picker. Each helper takes the data it needs as arguments so the picker's
 * `$derived.by` blocks become one-liner calls and the logic is unit-testable
 * without rendering a component.
 */

import type { ModelInfo } from '$lib/llm/models.server'

export type SortKey = 'name' | 'price' | 'context' | 'newest' | 'oldest'

/** Provider prefix from a model id like `anthropic/claude-sonnet-4` → `anthropic`. */
export function getCreator(id: string): string {
	const slash = id.indexOf('/')
	return slash > 0 ? id.slice(0, slash) : 'unknown'
}

/**
 * Collect the union of all input/output modalities the supplied models
 * advertise, used to populate the modality filter chips. The `direction`
 * argument selects which side of the modality pair to read.
 */
export function collectAvailableModalities(models: ModelInfo[], direction: 'input' | 'output'): string[] {
	const caps = new Set<string>()
	const key = direction === 'input' ? 'inputModalities' : 'outputModalities'
	for (const m of models) {
		for (const mod of m[key] ?? []) caps.add(mod)
	}
	return Array.from(caps).sort()
}

export type FilterModelsInput = {
	models: ModelInfo[]
	search: string
	selectedInputMods: Set<string>
	selectedOutputMods: Set<string>
	/** Hard-required input modality (e.g. 'audio' for the transcription picker). */
	requireInputModality?: string
}

/** Apply search + modality filters in a single pass — matches the picker's UX. */
export function filterModels(input: FilterModelsInput): ModelInfo[] {
	let result = input.models

	if (input.requireInputModality) {
		result = result.filter((m) => (m.inputModalities ?? []).includes(input.requireInputModality!))
	}

	if (input.search.trim()) {
		const lower = input.search.toLowerCase()
		result = result.filter(
			(m) =>
				m.id.toLowerCase().includes(lower) ||
				m.name.toLowerCase().includes(lower) ||
				(m.description ?? '').toLowerCase().includes(lower) ||
				(m.modality ?? '').toLowerCase().includes(lower) ||
				(m.instructType ?? '').toLowerCase().includes(lower) ||
				(m.inputModalities ?? []).join(' ').toLowerCase().includes(lower) ||
				(m.outputModalities ?? []).join(' ').toLowerCase().includes(lower),
		)
	}

	if (input.selectedInputMods.size > 0) {
		result = result.filter((m) => {
			const mods = new Set(m.inputModalities ?? [])
			for (const cap of input.selectedInputMods) {
				if (!mods.has(cap)) return false
			}
			return true
		})
	}

	if (input.selectedOutputMods.size > 0) {
		result = result.filter((m) => {
			const mods = new Set(m.outputModalities ?? [])
			for (const cap of input.selectedOutputMods) {
				if (!mods.has(cap)) return false
			}
			return true
		})
	}

	return result
}

/** Sort by one of the picker's 5 sort modes. Returns a new array. */
export function sortModels(models: ModelInfo[], sortBy: SortKey): ModelInfo[] {
	const list = [...models]
	switch (sortBy) {
		case 'name':
			list.sort((a, b) => a.name.localeCompare(b.name))
			break
		case 'price':
			list.sort((a, b) => Number(a.promptPrice) - Number(b.promptPrice))
			break
		case 'context':
			list.sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0))
			break
		case 'newest':
			list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
			break
		case 'oldest':
			list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
			break
	}
	return list
}

export type GroupedModels = { creator: string; models: ModelInfo[] }[]

/** Bucket models by provider prefix and sort the buckets alphabetically. */
export function groupModelsByCreator(models: ModelInfo[]): GroupedModels {
	const map = new Map<string, ModelInfo[]>()
	for (const m of models) {
		const creator = getCreator(m.id)
		if (!map.has(creator)) map.set(creator, [])
		map.get(creator)!.push(m)
	}
	return Array.from(map.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([creator, modelList]) => ({ creator, models: modelList }))
}
