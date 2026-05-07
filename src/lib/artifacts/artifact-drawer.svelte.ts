import { browser } from '$app/environment'

export type ArtifactTarget =
	| { kind: 'research'; id: string }
	| { kind: 'document'; artifactId: string }
	| { kind: 'image'; id: string }

const STORAGE_KEY = 'AgentStudio:artifact-drawer-width-pct'
const DEFAULT_WIDTH_PCT = 40
const MIN_PCT = 25
const MAX_PCT = 75

function loadInitialWidth(): number {
	if (!browser) return DEFAULT_WIDTH_PCT
	const raw = localStorage.getItem(STORAGE_KEY)
	if (!raw) return DEFAULT_WIDTH_PCT
	const v = parseFloat(raw)
	if (!Number.isFinite(v)) return DEFAULT_WIDTH_PCT
	return Math.max(MIN_PCT, Math.min(MAX_PCT, v))
}

function createArtifactDrawer() {
	let target = $state<ArtifactTarget | null>(null)
	let widthPct = $state<number>(loadInitialWidth())

	return {
		get isOpen() {
			return target !== null
		},
		get target() {
			return target
		},
		get widthPct() {
			return widthPct
		},
		open(t: ArtifactTarget) {
			target = t
		},
		close() {
			target = null
		},
		setWidthPct(pct: number) {
			const clamped = Math.max(MIN_PCT, Math.min(MAX_PCT, pct))
			widthPct = clamped
			if (browser) localStorage.setItem(STORAGE_KEY, String(clamped))
		},
	}
}

export const artifactDrawer = createArtifactDrawer()
export const ARTIFACT_DRAWER_MIN_PCT = MIN_PCT
export const ARTIFACT_DRAWER_MAX_PCT = MAX_PCT
