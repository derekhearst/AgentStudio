<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte'
</script>

<!-- #17 — the connectors live on their own page; this is the way there from Settings. -->
<ContentPanel>
	{#snippet header()}
		<div>
			<h2 class="flex items-center gap-2 text-base font-semibold">
				<span class="h-1.5 w-1.5 rounded-full bg-info"></span>
				Connectors
			</h2>
			<p class="mt-0.5 text-xs text-base-content/55">Remote MCP servers whose tools your chats can use</p>
		</div>
	{/snippet}
	{#snippet actions()}
		<a href="/settings/connectors" class="btn btn-ghost btn-xs">Manage connectors</a>
	{/snippet}
	<p class="text-xs text-base-content/60">
		Add a server over Streamable HTTP or SSE, test it, and choose per tool whether it runs without asking, asks every
		time, or is blocked.
	</p>
</ContentPanel>
