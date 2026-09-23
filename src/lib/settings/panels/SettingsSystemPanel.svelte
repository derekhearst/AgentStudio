<script lang="ts">
	import { onMount } from 'svelte'
	import ContentPanel from '$lib/ui/ContentPanel.svelte'
	import { getSystemReadiness } from '$lib/settings/settings.remote'
	import type { ReadinessRow } from '$lib/settings/readiness'
	import { remoteErrorMessage } from '$lib/ui/remote-error'

	/**
	 * Settings > System: read-only. These are set where the server is deployed (environment
	 * variables, the Claude Code CLI login, the workspace mount), not here — see readiness.ts
	 * for why first run no longer asks for them.
	 */
	let rows = $state<ReadinessRow[] | null>(null)
	let loadError = $state('')

	const blocking = $derived(rows?.filter((row) => row.required && !row.ok).length ?? 0)

	onMount(() => {
		getSystemReadiness()
			.then((result) => (rows = result))
			.catch((err) => (loadError = remoteErrorMessage(err, 'Could not load the system checklist')))
	})
</script>

<ContentPanel>
	{#snippet header()}
		<div>
			<h2 class="flex items-center gap-2 text-base font-semibold">
				<span class="h-1.5 w-1.5 rounded-full bg-success"></span>
				System
			</h2>
			<p class="mt-0.5 text-xs text-base-content/55">
				Set where the server is deployed, not here.
				{#if rows}
					{blocking === 0 ? 'Everything required is in place.' : `${blocking} required item${blocking === 1 ? '' : 's'} missing.`}
				{/if}
			</p>
		</div>
	{/snippet}

	{#if loadError}
		<p class="text-sm text-error">Could not read the system status: {loadError}</p>
	{:else if !rows}
		<p class="text-sm text-base-content/55"><span class="loading loading-spinner loading-xs"></span> Checking…</p>
	{:else}
		<ul class="divide-y divide-base-300/50" aria-label="System checklist">
			{#each rows as row (row.id)}
				<li class="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0" data-readiness={row.id} data-ok={row.ok}>
					<i
						class="mdi mt-0.5 text-base {row.ok
							? 'mdi-check-circle text-success'
							: row.required
								? 'mdi-alert-circle text-error'
								: 'mdi-minus-circle-outline text-base-content/40'}"
						aria-hidden="true"
					></i>
					<div class="min-w-0 flex-1">
						<p class="flex flex-wrap items-center gap-2 text-sm font-medium">
							{row.label}
							<span class="sr-only">{row.ok ? '— ready' : row.required ? '— missing, required' : '— off'}</span>
							{#if !row.required}
								<span class="badge badge-ghost badge-xs">optional</span>
							{/if}
						</p>
						<p class="mt-0.5 text-xs text-base-content/60">{row.detail}</p>
						{#if row.envVars.length > 0}
							<p class="mt-1 flex flex-wrap gap-1">
								{#each row.envVars as name (name)}
									<code class="rounded bg-base-200 px-1 py-0.5 text-[11px]">{name}</code>
								{/each}
							</p>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</ContentPanel>
