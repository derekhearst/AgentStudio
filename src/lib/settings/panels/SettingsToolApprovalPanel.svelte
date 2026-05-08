<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte'
	import ToolToggleChip from '$lib/settings/ToolToggleChip.svelte'
	import { BUILTIN_TOOLS } from '$lib/tools/tools'

	type ToolConfig = {
		approvalRequiredTools: string[]
		programmaticToolCallingEnabled?: boolean
	}

	let { toolConfig, searchQuery = '' }: { toolConfig: ToolConfig; searchQuery?: string } = $props()

	// Tool tiers come from `toolDisclosure`: 'always' = loaded every request, 'searchable' =
	// loaded on-demand via `search_tools`. The UI groups tools by tier so operators can bulk-
	// approve a tier (e.g. require approval for every searchable tool but waive the always set).
	const TIER_META: Array<{
		tierKey: 'always' | 'searchable'
		label: string
		description: string
		alwaysOn: boolean
	}> = [
		{
			tierKey: 'always',
			label: 'Always loaded',
			description:
				'Tools shipped in the model surface on every request (web_search, ask_user, run_code, search_tools).',
			alwaysOn: true,
		},
		{
			tierKey: 'searchable',
			label: 'Searchable',
			description:
				'The long tail of tools — loaded only after the model invokes `search_tools(query)`.',
			alwaysOn: false,
		},
	]
	const toolsByTier = TIER_META
		.map(({ tierKey, label, description, alwaysOn }) => ({
			tierKey,
			tier: { label, description, alwaysOn },
			tools: BUILTIN_TOOLS.filter((tool) => tool.tier === tierKey),
		}))
		.filter((entry) => entry.tools.length > 0)

	const searchLower = $derived(searchQuery.toLowerCase().trim())
	const filteredToolsByTier = $derived.by(() => {
		if (!searchLower) return toolsByTier
		return toolsByTier
			.map((g) => ({
				...g,
				tools: g.tools.filter(
					(t) =>
						t.name.toLowerCase().includes(searchLower) ||
						t.description.toLowerCase().includes(searchLower),
				),
			}))
			.filter((g) => g.tools.length > 0)
	})

	const isWildcardApproval = $derived((toolConfig.approvalRequiredTools ?? []).includes('*'))

	function isToolApprovalRequired(toolName: string): boolean {
		const requiredTools = toolConfig.approvalRequiredTools ?? []
		return requiredTools.includes('*') || requiredTools.includes(toolName)
	}

	let statusMessage = $state('')

	function toggleToolApproval(toolName: string, required: boolean) {
		// If the wildcard is currently active, toggling any specific tool would silently
		// strip the "approve every tool" posture. Refuse — operator must clear the
		// wildcard explicitly via the master toggle below.
		if (isWildcardApproval) {
			statusMessage = 'Per-tool approval is disabled while "Require approval for all tools" is on.'
			setTimeout(() => (statusMessage = ''), 3500)
			return
		}
		const base = toolConfig.approvalRequiredTools ?? []
		toolConfig.approvalRequiredTools = required
			? [...new Set([...base, toolName])]
			: base.filter((name) => name !== toolName)
	}

	function setWildcardApproval(value: boolean) {
		const current = toolConfig.approvalRequiredTools ?? []
		const without = current.filter((name) => name !== '*')
		toolConfig.approvalRequiredTools = value ? [...without, '*'] : without
	}

	function setTierApproval(tierKey: 'always' | 'searchable', required: boolean) {
		if (isWildcardApproval) return
		// `always` tools never have approval pre-set en-masse; the UI hides the bulk-controls
		// for that tier. Defensive guard for callers passing it anyway.
		if (tierKey === 'always') return
		const tierTools = BUILTIN_TOOLS.filter((t) => t.tier === tierKey).map((t) => t.name)
		const base = toolConfig.approvalRequiredTools ?? []
		let next = base.filter((n) => !tierTools.includes(n))
		if (required) next = [...new Set([...next, ...tierTools])]
		toolConfig.approvalRequiredTools = next
	}
</script>

<ContentPanel>
	{#snippet header()}
		<h2 class="flex items-center gap-2 text-base font-semibold">
			<span class="h-1.5 w-1.5 rounded-full bg-secondary"></span>
			Tool Approval
		</h2>
	{/snippet}

	{#if statusMessage}
		<div class="alert alert-warning py-2 text-xs mb-2">{statusMessage}</div>
	{/if}

	<label class="mb-3 flex items-start justify-between gap-3 rounded-md border border-info/40 bg-info/5 px-3 py-2.5">
		<span>
			<span class="block text-sm font-medium">Programmatic tool calling</span>
			<span class="block text-xs text-base-content/60">
				Expose <code>run_code</code> so the agent can write a JavaScript program that calls available tools as <code>await tools.&lt;name&gt;(args)</code>. Approvals and capability filtering still apply inside the script.
			</span>
		</span>
		<input
			type="checkbox"
			class="checkbox checkbox-sm checkbox-info mt-0.5"
			checked={toolConfig.programmaticToolCallingEnabled ?? false}
			onchange={(e) => {
				toolConfig.programmaticToolCallingEnabled = (e.currentTarget as HTMLInputElement).checked
			}}
		/>
	</label>

	<label class="mb-3 flex items-start justify-between gap-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5">
		<span>
			<span class="block text-sm font-medium">Require approval for all tools</span>
			<span class="block text-xs text-base-content/60">When on, every tool call pauses for explicit approval. Per-tool toggles below are ignored while this is on.</span>
		</span>
		<input
			type="checkbox"
			class="checkbox checkbox-sm checkbox-warning mt-0.5"
			checked={isWildcardApproval}
			onchange={(e) => setWildcardApproval((e.currentTarget as HTMLInputElement).checked)}
		/>
	</label>

	<div
		class="flex flex-col gap-5"
		class:opacity-60={isWildcardApproval}
		class:pointer-events-none={isWildcardApproval}
		aria-disabled={isWildcardApproval}
	>
		{#each filteredToolsByTier as tierEntry (tierEntry.tierKey)}
			{@const alwaysOn = tierEntry.tier.alwaysOn}
			<div>
				<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
					<div class="min-w-0">
						<p class="flex items-center gap-2 text-sm font-medium">
							{tierEntry.tier.label}
							{#if alwaysOn}
								<span class="badge badge-success badge-xs">Always loaded</span>
							{/if}
						</p>
						<p class="mt-0.5 text-xs text-base-content/55">{tierEntry.tier.description}</p>
					</div>
					{#if !alwaysOn}
						<div class="flex shrink-0 items-center gap-1">
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								onclick={() => setTierApproval(tierEntry.tierKey, true)}
								disabled={isWildcardApproval}
							>All</button>
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								onclick={() => setTierApproval(tierEntry.tierKey, false)}
								disabled={isWildcardApproval}
							>None</button>
						</div>
					{/if}
				</div>
				<div
					class="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
					class:opacity-60={alwaysOn}
					class:pointer-events-none={alwaysOn}
				>
					{#each tierEntry.tools as tool (tool.name)}
						<ToolToggleChip
							name={tool.name}
							description={tool.description}
							checked={isToolApprovalRequired(tool.name)}
							disabled={alwaysOn}
							onchange={(value) => toggleToolApproval(tool.name, value)}
						/>
					{/each}
				</div>
			</div>
		{:else}
			<p class="text-sm text-base-content/55">No tools match "{searchQuery}".</p>
		{/each}
	</div>
</ContentPanel>
