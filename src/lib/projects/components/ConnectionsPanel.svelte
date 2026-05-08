<script lang="ts">
	import type { getProjectsOverviewQuery } from '$lib/projects/projects.remote'

	type Overview = Awaited<ReturnType<typeof getProjectsOverviewQuery>>
	type Connection = Overview['connections'][number]

	let { overview, onDisconnectGithub, onDisconnectAzure } = $props<{
		overview: Overview | null
		onDisconnectGithub: () => void
		onDisconnectAzure: () => void
	}>()

	const githubConnection = $derived<Connection | null>(
		overview?.connections.find((c: Connection) => c.provider === 'github' && c.status === 'active') ?? null,
	)
	const githubRevoked = $derived<Connection | null>(
		overview?.connections.find((c: Connection) => c.provider === 'github' && c.status !== 'active') ?? null,
	)
	const azureConnections = $derived<Connection[]>(
		overview?.connections.filter((c: Connection) => c.provider === 'azure_devops' && c.status === 'active') ?? [],
	)
</script>

<div class="grid gap-3 sm:grid-cols-2">
	<div class="rounded-lg border border-base-300 bg-base-100 p-4">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-3">
				<div class="text-2xl">⚡</div>
				<div>
					<div class="font-semibold">GitHub</div>
					{#if githubConnection}
						<div class="text-sm opacity-70">
							Connected as <code>{githubConnection.providerAccount}</code>
							<span class="badge badge-success badge-xs ml-2">active</span>
						</div>
					{:else if githubRevoked}
						<div class="text-sm opacity-70">
							Previously connected as <code>{githubRevoked.providerAccount}</code>
							<span class="badge badge-error badge-xs ml-2">{githubRevoked.status}</span>
						</div>
					{:else}
						<div class="text-sm opacity-70">Not connected.</div>
					{/if}
				</div>
			</div>
			<div class="flex gap-2">
				{#if !overview?.githubConfigured && !githubConnection}
					<span class="badge badge-warning badge-sm" title="Set GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET in env">
						Not configured
					</span>
				{:else if githubConnection}
					<a class="btn btn-outline btn-xs" href="/source-control/github/connect">Reconnect</a>
					<button class="btn btn-error btn-outline btn-xs" type="button" onclick={onDisconnectGithub}>
						Disconnect
					</button>
				{:else}
					<a class="btn btn-primary btn-xs" href="/source-control/github/connect">Connect</a>
				{/if}
			</div>
		</div>
	</div>

	<div class="rounded-lg border border-base-300 bg-base-100 p-4">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-3">
				<div class="text-2xl">🔷</div>
				<div>
					<div class="font-semibold">Azure DevOps</div>
					{#if azureConnections.length > 0}
						<div class="text-sm opacity-70">
							Connected to {azureConnections.length} {azureConnections.length === 1 ? 'org' : 'orgs'}:
							{#each azureConnections as c, i (c.id)}
								<code>{c.providerAccount}</code>{i < azureConnections.length - 1 ? ', ' : ''}
							{/each}
						</div>
					{:else}
						<div class="text-sm opacity-70">Not connected.</div>
					{/if}
				</div>
			</div>
			<div class="flex gap-2">
				{#if !overview?.azureConfigured && azureConnections.length === 0}
					<span class="badge badge-warning badge-sm" title="Set AZURE_DEVOPS_OAUTH_CLIENT_ID + AZURE_DEVOPS_OAUTH_CLIENT_SECRET in env">
						Not configured
					</span>
				{:else if azureConnections.length > 0}
					<a class="btn btn-outline btn-xs" href="/source-control/azure-devops/connect">Reconnect</a>
					<button class="btn btn-error btn-outline btn-xs" type="button" onclick={onDisconnectAzure}>
						Disconnect
					</button>
				{:else}
					<a class="btn btn-primary btn-xs" href="/source-control/azure-devops/connect">Connect</a>
				{/if}
			</div>
		</div>
	</div>
</div>
