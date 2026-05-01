/**
 * End-to-end smoke run: ingest → retrieve → score-retrieval over a small slice
 * of the oracle dataset. Useful for fast iteration without running the full 500.
 *
 * Usage:
 *   bun run scripts/bench/longmemeval/smoke.ts [--dataset=oracle] [--limit=5]
 */

import { spawnSync } from 'node:child_process'
import { newRunId } from './bench.config'

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.map((a) => a.match(/^--([^=]+)=(.+)$/))
		.filter((m): m is RegExpMatchArray => Boolean(m))
		.map((m) => [m[1], m[2]]),
)
const dataset = args.dataset ?? 'oracle'
const limit = args.limit ?? '5'
const runId = args.runId ?? newRunId()
const maxSessions = args.maxSessions

function run(label: string, cmd: string[]): void {
	const withOverride = ['--tsconfig-override=scripts/bench/tsconfig.json', ...cmd]
	console.log(`\n=== ${label}: bun ${withOverride.join(' ')} ===`)
	const result = spawnSync('bun', withOverride, { stdio: 'inherit', shell: true })
	if (result.status !== 0) {
		console.error(`[smoke] ${label} failed (status=${result.status})`)
		process.exit(result.status ?? 1)
	}
}

console.log(
	`[smoke] runId=${runId} dataset=${dataset} limit=${limit}${maxSessions ? ` maxSessions=${maxSessions}` : ''}`,
)
const ingestArgs = [
	'run',
	'scripts/bench/longmemeval/ingest.ts',
	`--dataset=${dataset}`,
	`--runId=${runId}`,
	`--limit=${limit}`,
]
if (maxSessions) ingestArgs.push(`--maxSessions=${maxSessions}`)
run('ingest', ingestArgs)
run('retrieve', [
	'run',
	'scripts/bench/longmemeval/retrieve.ts',
	`--dataset=${dataset}`,
	`--runId=${runId}`,
	`--limit=${limit}`,
])
run('score-retrieval', ['run', 'scripts/bench/longmemeval/score-retrieval.ts', `--runId=${runId}`])
console.log(`\n[smoke] OK — runId=${runId}`)
