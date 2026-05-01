/**
 * LongMemEval bench shared config + helpers.
 *
 * Layout:
 *   data/longmemeval/                  raw datasets (downloaded)
 *   retrieval_logs/{runId}.jsonl       per-run retrieval output
 *   generation_logs/{runId}.jsonl      per-run QA hypotheses
 */

import path from 'node:path'
import fs from 'node:fs'

export const DATA_DIR = path.resolve('data/longmemeval')
export const RETRIEVAL_LOG_DIR = path.resolve('retrieval_logs')
export const GENERATION_LOG_DIR = path.resolve('generation_logs')

export const DATASETS = {
	oracle: 'longmemeval_oracle.json',
	s: 'longmemeval_s_cleaned.json',
	m: 'longmemeval_m_cleaned.json',
} as const

export type DatasetKey = keyof typeof DATASETS

export const DATASET_URLS: Record<DatasetKey, string> = {
	oracle: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json',
	s: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
	m: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_m_cleaned.json',
}

export type LmeTurn = {
	role: 'user' | 'assistant'
	content: string
	has_answer?: boolean
}

export type LmeInstance = {
	question_id: string
	question_type:
		| 'single-session-user'
		| 'single-session-assistant'
		| 'single-session-preference'
		| 'temporal-reasoning'
		| 'knowledge-update'
		| 'multi-session'
	question: string
	answer: string
	question_date: string
	haystack_session_ids: string[]
	haystack_dates: string[]
	haystack_sessions: LmeTurn[][]
	answer_session_ids: string[]
}

export function ensureDir(dir: string) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function loadDataset(key: DatasetKey): LmeInstance[] {
	const file = path.join(DATA_DIR, DATASETS[key])
	if (!fs.existsSync(file)) {
		throw new Error(`Dataset ${key} not found at ${file}. Run "bun run bench:longmemeval:download" first.`)
	}
	return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

/** Stable synthetic user UUID per (runId, questionId). */
export function syntheticUserId(runId: string, questionId: string): string {
	// Deterministic UUID v5-like derivation via crypto.subtle would be nice, but for
	// the bench we just need uniqueness within Postgres; use a hash → UUID format.
	const crypto = require('node:crypto') as typeof import('node:crypto')
	const hash = crypto.createHash('sha1').update(`${runId}::${questionId}`).digest('hex')
	return [
		hash.slice(0, 8),
		hash.slice(8, 12),
		'5' + hash.slice(13, 16), // version 5
		'8' + hash.slice(17, 20),
		hash.slice(20, 32),
	].join('-')
}

export function newRunId(): string {
	const stamp = new Date()
		.toISOString()
		.replace(/[:.TZ-]/g, '')
		.slice(0, 14)
	const rand = Math.random().toString(36).slice(2, 6)
	return `lme_${stamp}_${rand}`
}

/** Stable synthetic UUID derived from any seed (used for bench conversationId). */
export function syntheticUuid(seed: string): string {
	const crypto = require('node:crypto') as typeof import('node:crypto')
	const hash = crypto.createHash('sha1').update(seed).digest('hex')
	return [
		hash.slice(0, 8),
		hash.slice(8, 12),
		'5' + hash.slice(13, 16),
		'8' + hash.slice(17, 20),
		hash.slice(20, 32),
	].join('-')
}
