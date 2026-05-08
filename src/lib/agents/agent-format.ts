/**
 * Display helpers for agent UIs.
 *
 * Pure functions — no I/O, no Svelte state — so they're equally usable from the
 * agents page, agents/[id] detail, the model picker, or any future surface that
 * lists agents. Color constants are exported so a sub-component (e.g. avatar
 * badge) can pick from the same palette as the parent card.
 */

export const AGENT_COLORS = [
	{ ring: 'ring-primary/40', bg: 'bg-primary/15', text: 'text-primary', accent: 'border-primary', gradFrom: 'from-primary/20', gradTo: 'to-primary/5' },
	{ ring: 'ring-secondary/40', bg: 'bg-secondary/15', text: 'text-secondary', accent: 'border-secondary', gradFrom: 'from-secondary/20', gradTo: 'to-secondary/5' },
	{ ring: 'ring-accent/40', bg: 'bg-accent/15', text: 'text-accent', accent: 'border-accent', gradFrom: 'from-accent/20', gradTo: 'to-accent/5' },
	{ ring: 'ring-info/40', bg: 'bg-info/15', text: 'text-info', accent: 'border-info', gradFrom: 'from-info/20', gradTo: 'to-info/5' },
	{ ring: 'ring-success/40', bg: 'bg-success/15', text: 'text-success', accent: 'border-success', gradFrom: 'from-success/20', gradTo: 'to-success/5' },
	{ ring: 'ring-warning/40', bg: 'bg-warning/15', text: 'text-warning', accent: 'border-warning', gradFrom: 'from-warning/20', gradTo: 'to-warning/5' },
] as const

const MODEL_LEFT_BORDER: Record<string, string> = {
	claude: 'border-l-purple-500/50',
	gpt: 'border-l-green-500/50',
	gemini: 'border-l-blue-500/50',
	mistral: 'border-l-orange-500/50',
	llama: 'border-l-pink-500/50',
}

export function agentColor(id: string) {
	return AGENT_COLORS[id.charCodeAt(0) % AGENT_COLORS.length]
}

export function agentInitials(name: string) {
	return name
		.split(/\s+/)
		.map((w) => w[0] ?? '')
		.join('')
		.slice(0, 2)
		.toUpperCase()
}

export function modelLeftBorder(model: string | null | undefined) {
	if (!model) return 'border-l-base-300'
	const key = Object.keys(MODEL_LEFT_BORDER).find((k) => model.toLowerCase().includes(k))
	return key ? MODEL_LEFT_BORDER[key] : 'border-l-base-300'
}

export function modelShortName(model: string) {
	return model.split('/').pop() ?? model
}

import { relativeTime as relativeTimeRaw } from '$lib/util/relative-time'

// Capitalized variant ("Never" / "Just now") used throughout the agents UI.
export const relativeTime = (date: Date | string | null | undefined): string =>
	relativeTimeRaw(date, { style: 'capitalized' })

export function formatDate(date: Date | string | null | undefined): string {
	if (!date) return '—'
	return new Date(typeof date === 'string' ? date : date).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	})
}

export function formatCost(cost: string | number | null | undefined): string {
	const n = typeof cost === 'string' ? parseFloat(cost) : (cost ?? 0)
	if (n === 0) return '$0.00'
	return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}

export function formatTokens(n: number | null | undefined): string {
	if (!n) return '0'
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
	return String(n)
}

/**
 * Convert a 5-field cron expression into a short human-readable phrase.
 * Falls back to the raw expression for cases this lookup doesn't cover.
 */
export function describeSchedule(cron: string): string {
	const parts = cron.split(' ')
	if (parts.length !== 5) return cron
	const [min, hour] = parts
	if (min === '0' && hour === '*') return 'Every hour'
	if (min === '0' && hour === '0') return 'Daily midnight'
	if (min === '*/30') return 'Every 30 minutes'
	if (min === '*/15') return 'Every 15 minutes'
	if (min === '*/5') return 'Every 5 minutes'
	return cron
}
