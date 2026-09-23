import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from '@playwright/test'
import { authenticateContext, waitForHydration } from './helpers'

/**
 * The creation forms on /automations and /monitors sit in a right-hand column on a wide
 * screen and stack under the list on a narrow one.
 *
 * Both pages asked for that with an arbitrary `xl:grid-cols-…` value whose two tracks
 * were separated by a comma (`1.2fr,0.8fr`). Tailwind v4 passes an arbitrary value
 * through as written, so that compiled to `grid-template-columns: 1.2fr,.8fr` — which is
 * not valid CSS, so the browser dropped the declaration and the form rendered below the
 * whole list at every width. Spaces in an arbitrary value are written as underscores:
 * `[1.2fr_0.8fr]`.
 *
 * (Written out of class form on purpose: Tailwind scans this file too, and the literal
 * class would put the broken rule back into the built CSS.)
 */

test.describe('two-column creation layout', () => {
	const PAGES = [
		{ path: '/automations', heading: 'Create a new automation' },
		{ path: '/monitors', heading: 'New monitor' },
	]

	for (const { path, heading } of PAGES) {
		test(`${path} puts the form beside the list when there is room`, async ({ page }, testInfo) => {
			await authenticateContext(page.context())
			await page.goto(path)
			await waitForHydration(page)

			const form = page.getByRole('heading', { name: heading })
			await expect(form).toBeVisible()
			const box = await form.boundingBox()
			const viewport = page.viewportSize()
			expect(box && viewport).toBeTruthy()

			if (testInfo.project.name === 'desktop') {
				// 1440px is past the xl breakpoint: the form is in the right-hand column.
				expect(box!.x).toBeGreaterThan(viewport!.width / 2)
			} else {
				// A phone stacks it under the list, starting at the left edge.
				expect(box!.x).toBeLessThan(viewport!.width / 2)
			}
		})
	}
})

test('no arbitrary grid template in src/ uses a top-level comma', () => {
	const root = join(process.cwd(), 'src')
	const files: string[] = []
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) walk(path)
			else if (/\.(svelte|ts)$/.test(entry.name)) files.push(path)
		}
	}
	walk(root)

	// A comma inside a function — `minmax(0,1fr)`, `repeat(2,1fr)` — is valid; one between
	// tracks is not, and the whole declaration is silently discarded.
	const hasTopLevelComma = (value: string) => {
		let depth = 0
		for (const char of value) {
			if (char === '(') depth++
			else if (char === ')') depth--
			else if (char === ',' && depth === 0) return true
		}
		return false
	}

	const offenders: string[] = []
	for (const file of files) {
		const source = readFileSync(file, 'utf8')
		for (const match of source.matchAll(/grid-(?:cols|rows)-\[([^\]\s]+)\]/g)) {
			if (hasTopLevelComma(match[1])) offenders.push(`${relative(process.cwd(), file)}: ${match[0]}`)
		}
	}
	expect(offenders, 'use `_` between tracks, e.g. grid-cols-[1.2fr_0.8fr]').toEqual([])
})
