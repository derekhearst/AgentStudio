<script lang="ts">
	import type { getProjectsOverviewQuery } from '$lib/projects/projects.remote'

	type Overview = Awaited<ReturnType<typeof getProjectsOverviewQuery>>
	type Connection = Overview['connections'][number]

	let { overview, onDisconnectGithub } = $props<{
		overview: Overview | null
		onDisconnectGithub: () => void
	}>()

	const githubConnection = $derived<Connection | null>(
		overview?.connections.find((c: Connection) => c.provider === 'github' && c.status === 'active') ?? null,
	)
	const githubRevoked = $derived<Connection | null>(
		overview?.connections.find((c: Connection) => c.provider === 'github' && c.status !== 'active') ?? null,
	)
</script>

<div>
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
</div>
