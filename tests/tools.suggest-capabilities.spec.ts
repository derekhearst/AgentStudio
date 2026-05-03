import { expect, test } from '@playwright/test'
import {
	suggestCapabilityGroups,
	suggestCapabilityGroupsExplained,
} from '../src/lib/tools/suggest-capabilities'

test.describe('tools/suggest-capabilities — strong keywords (single-match decisive)', () => {
	test('"can you fix the bug in the auth file" → sandbox', () => {
		expect(suggestCapabilityGroups('can you fix the bug in the auth file')).toEqual(['sandbox'])
	})

	test('"create a skill that explains our deploy process" → skills', () => {
		expect(suggestCapabilityGroups('create a skill that explains our deploy process')).toEqual(['skills'])
	})

	test('"set up an automation to run the report each Monday" → agents', () => {
		expect(suggestCapabilityGroups('set up an automation to run the report each Monday')).toContain('agents')
	})

	test('"draw a logo for the new product" → media', () => {
		expect(suggestCapabilityGroups('draw a logo for the new product')).toEqual(['media'])
	})
})

test.describe('tools/suggest-capabilities — multiple groups can fire', () => {
	test('"delegate the file editing to the coding agent" picks up agents AND sandbox', () => {
		const groups = suggestCapabilityGroups('delegate the file editing to the coding agent')
		expect(groups).toContain('agents')
		expect(groups).toContain('sandbox')
	})

	test('"create a skill explaining how to commit and push code" picks up skills AND sandbox', () => {
		const groups = suggestCapabilityGroups('create a skill explaining how to commit and push code')
		expect(groups).toContain('skills')
		expect(groups).toContain('sandbox')
	})
})

test.describe('tools/suggest-capabilities — conservative on weak signal', () => {
	test('a single supporting word does NOT fire (run, open, check, etc.)', () => {
		// 'run' is supporting-only for sandbox — alone shouldn't trigger.
		expect(suggestCapabilityGroups('how does this run on macOS?')).toEqual([])
	})

	test('two supporting words DO fire (the threshold)', () => {
		// 'run' + 'check' both supporting for sandbox.
		const groups = suggestCapabilityGroups('can you run a check before continuing')
		expect(groups).toContain('sandbox')
	})

	test('empty / whitespace messages return no suggestions', () => {
		expect(suggestCapabilityGroups('')).toEqual([])
		expect(suggestCapabilityGroups('   \n  ')).toEqual([])
	})

	test('substring matches do NOT fire (whole-word boundary)', () => {
		// 'agentic' contains 'agent' but the whole-word check should reject it.
		expect(suggestCapabilityGroups('this is an agentic discussion')).not.toContain('agents')
		// 'codeword' contains 'code' but is a different concept.
		expect(suggestCapabilityGroups('what is the codeword for the meeting')).not.toContain('sandbox')
	})
})

test.describe('tools/suggest-capabilities — explanation surface', () => {
	test('returns matched keywords for telemetry / debugging false positives', () => {
		const explained = suggestCapabilityGroupsExplained('please patch the file_read bug and run tests')
		const sandbox = explained.find((s) => s.group === 'sandbox')
		expect(sandbox).toBeTruthy()
		expect(sandbox!.matchedStrong.length).toBeGreaterThan(0)
		// 'patch' is strong, 'tests' is strong, 'run' is supporting.
		expect(sandbox!.matchedStrong).toContain('patch')
		expect(sandbox!.matchedStrong).toContain('tests')
	})

	test('hyphenated supporting keywords match correctly (sub-agent / how-to)', () => {
		// 'sub-agent' is in agents.strong; whole-word match should accept the hyphen.
		const groups = suggestCapabilityGroups('hand this to the sub-agent for follow-up')
		expect(groups).toContain('agents')
	})
})
