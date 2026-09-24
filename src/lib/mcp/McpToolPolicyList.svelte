<script lang="ts">
	import {
		MCP_TOOL_POLICIES,
		MCP_TOOL_POLICY_LABELS,
		type McpToolPolicy,
		type McpToolSnapshot
	} from '$lib/mcp/mcp-config';

	/**
	 * A connector's tools and what each one may do (#17): Allow, Ask or Block.
	 *
	 * The list is what the last connection test saw. A tool not listed here — a server that
	 * added one since — asks, like any tool without a setting. The read-only and destructive
	 * badges are the server's own claims: shown so the operator can decide, and never used to
	 * decide anything.
	 */

	let {
		connectorLabel,
		tools,
		policies,
		busy = false,
		onChange
	}: {
		connectorLabel: string;
		tools: McpToolSnapshot[];
		policies: Record<string, McpToolPolicy>;
		busy?: boolean;
		onChange: (next: Record<string, McpToolPolicy>) => void;
	} = $props();

	const ACTIVE: Record<McpToolPolicy, string> = {
		allow: 'btn-success',
		ask: 'btn-neutral',
		block: 'btn-error'
	};

	function policyOf(name: string): McpToolPolicy {
		return policies[name] ?? 'ask';
	}

	function setOne(name: string, policy: McpToolPolicy) {
		if (policyOf(name) === policy) return;
		onChange({ ...policies, [name]: policy });
	}

	function setAll(policy: McpToolPolicy) {
		const next: Record<string, McpToolPolicy> = { ...policies };
		for (const tool of tools) next[tool.name] = policy;
		onChange(next);
	}
</script>

<div class="space-y-2">
	<div class="flex flex-wrap items-center gap-2 text-xs">
		<span class="opacity-60">Every tool:</span>
		{#each MCP_TOOL_POLICIES as policy (policy)}
			<button
				type="button"
				class="btn btn-ghost btn-xs"
				disabled={busy}
				onclick={() => setAll(policy)}
				aria-label={`${MCP_TOOL_POLICY_LABELS[policy]} every ${connectorLabel} tool`}
			>
				{MCP_TOOL_POLICY_LABELS[policy]}
			</button>
		{/each}
	</div>

	<ul class="divide-y divide-base-300/50">
		{#each tools as tool (tool.name)}
			{@const current = policyOf(tool.name)}
			<li class="flex flex-col gap-2 py-2 tablet:flex-row tablet:items-start tablet:justify-between">
				<div class="min-w-0 tablet:flex-1">
					<div class="flex flex-wrap items-center gap-1.5">
						<code class="break-all text-xs font-semibold">{tool.name}</code>
						{#if tool.readOnly}
							<span class="badge badge-ghost badge-xs" title="The server says this tool only reads">read-only</span>
						{/if}
						{#if tool.destructive}
							<span class="badge badge-warning badge-soft badge-xs" title="The server says this tool can destroy data">destructive</span>
						{/if}
					</div>
					{#if tool.title && tool.title !== tool.name}
						<p class="text-xs font-medium opacity-75">{tool.title}</p>
					{/if}
					{#if tool.description}
						<p class="mt-0.5 line-clamp-2 break-words text-xs opacity-60">{tool.description}</p>
					{/if}
				</div>
				<div class="join shrink-0" role="group" aria-label={`Policy for ${tool.name}`}>
					{#each MCP_TOOL_POLICIES as policy (policy)}
						<button
							type="button"
							class="join-item btn btn-xs {current === policy ? ACTIVE[policy] : 'btn-ghost border-base-300'}"
							aria-pressed={current === policy}
							disabled={busy}
							onclick={() => setOne(tool.name, policy)}
						>
							{MCP_TOOL_POLICY_LABELS[policy]}
						</button>
					{/each}
				</div>
			</li>
		{/each}
	</ul>
</div>
