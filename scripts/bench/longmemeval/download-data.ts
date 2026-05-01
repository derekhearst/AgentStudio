/**
 * Download the three LongMemEval JSON files into data/longmemeval/.
 *   bun run bench:longmemeval:download
 */

import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, DATASETS, DATASET_URLS, ensureDir, type DatasetKey } from './bench.config'

async function downloadOne(key: DatasetKey) {
	const url = DATASET_URLS[key]
	const target = path.join(DATA_DIR, DATASETS[key])
	if (fs.existsSync(target) && fs.statSync(target).size > 0) {
		console.log(`[download] ✓ ${DATASETS[key]} already present (${fs.statSync(target).size} bytes)`)
		return
	}
	console.log(`[download] fetching ${url}`)
	const res = await fetch(url, { redirect: 'follow' })
	if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`)
	if (!res.body) throw new Error(`No body returned for ${url}`)
	const buf = Buffer.from(await res.arrayBuffer())
	fs.writeFileSync(target, buf)
	console.log(`[download] ✓ wrote ${target} (${buf.length} bytes)`)
}

async function main() {
	ensureDir(DATA_DIR)
	for (const key of Object.keys(DATASETS) as DatasetKey[]) {
		await downloadOne(key)
	}
	console.log('[download] all datasets present in', DATA_DIR)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
