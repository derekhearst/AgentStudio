<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte'
	import ToolToggleChip from '$lib/settings/ToolToggleChip.svelte'
	import { BUILTIN_TOOLS } from '$lib/tools/tools'

	type ToolConfig = {
		approvalRequiredTools: string[]
	}

	let { toolConfig, searchQuery = '' }: { toolConfig: ToolConfig; searchQuery?: string } = $props()

	// One flat list: every registry tool a chat run can call, each one toggleable. It used to
	// be split into an "always loaded" tier, whose chips were locked, and a "searchable" tier —
	// the old loop's deferred loading, which the chat engine never had (#8). The lock left
	// web_search impossible to gate except through the wildcard.
	const searchLower = $derived(searchQuery.toLowerCase().trim())
	const filteredTools = $derived(
		searchLower
			? BUILTIN_TOOLS.filter(
					(t) =>
						t.name.toLowerCase().includes(searchLower) ||
						t.description.toLowerCase().includes(searchLower),
				)
			: BUILTIN_TOOLS,
	)

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

	function setAllApproval(required: boolean) {
		if (isWildcardApproval) return
		const listed = BUILTIN_TOOLS.map((t) => t.name)
		const base = toolConfig.approvalRequiredTools ?? []
		let next = base.filter((n) => !listed.includes(n))
		if (required) next = [...new Set([...next, ...listed])]
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
		class="flex flex-col gap-2"
		class:opacity-60={isWildcardApproval}
		class:pointer-events-none={isWildcardApproval}
		aria-disabled={isWildcardApproval}
	>
		<div class="flex flex-wrap items-center justify-between gap-2">
			<p class="min-w-0 text-xs text-base-content/55">Checked tools pause for your approval before they run.</p>
			<div class="flex shrink-0 items-center gap-1">
				<button type="button" class="btn btn-ghost btn-xs" onclick={() => setAllApproval(true)} disabled={isWildcardApproval}>All</button>
				<button type="button" class="btn btn-ghost btn-xs" onclick={() => setAllApproval(false)} disabled={isWildcardApproval}>None</button>
			</div>
		</div>
		{#if filteredTools.length > 0}
			<div class="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
				{#each filteredTools as tool (tool.name)}
					<ToolToggleChip
						name={tool.name}
						description={tool.description}
						checked={isToolApprovalRequired(tool.name)}
						onchange={(value) => toggleToolApproval(tool.name, value)}
					/>
				{/each}
			</div>
		{:else}
			<p class="text-sm text-base-content/55">No tools match "{searchQuery}".</p>
		{/if}
	</div>
</ContentPanel>
