import { expect, test } from '@playwright/test'
import { DETACHED_RUN_TOOLS, detachedRunToolNames } from '../src/lib/runtime/detached-tools'
import { allToolNames } from '../src/lib/tools/tool-schemas'

/**
 * The tools an unattended old-loop run is offered (automations with an agent attached, a
 * monitor's start_conversation, a CI fix run).
 *
 * Pure: no database, no dev server.
 *
 * Before #8 and #69 this list was the registry's "always loaded" tier — web_search, ask_user,
 * run_code, search_tools — minus ask_user. Deleting two of those tools must not quietly widen
 * what these runs can do: they have no approval surface. So this pins that the list is what
 * was left, and that `allowedTools` can still only narrow it.
 */

test('an unscoped run gets web_search and nothing else', () => {
	expect(detachedRunToolNames()).toEqual(['web_search'])
	expect(detachedRunToolNames(null)).toEqual(['web_search'])
	expect(detachedRunToolNames([])).toEqual(['web_search'])
})

test('allowedTools narrows the list and cannot widen it', () => {
	expect(detachedRunToolNames(['web_search', 'web_fetch'])).toEqual(['web_search'])
	// A scope without web_search leaves the run with no registry tools, as it did before:
	// the tier filter ran first and allowedTools only filtered what it let through.
	expect(detachedRunToolNames(['web_fetch', 'delete_file'])).toEqual([])
})

test('the retired tools and ask_user are never offered', () => {
	const offered = new Set<string>(detachedRunToolNames())
	for (const name of ['run_code', 'search_tools', 'ask_user']) {
		expect(offered.has(name), name).toBe(false)
	}
})

test('every name is a real registry tool', () => {
	for (const name of DETACHED_RUN_TOOLS) {
		expect(allToolNames).toContain(name)
	}
})
