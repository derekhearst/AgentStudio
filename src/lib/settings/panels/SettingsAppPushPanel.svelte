<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte'

	let {
		installAvailable,
		pushEnabled,
		subscriptionCount,
		busy = false,
		onInstall,
		onEnablePush,
		onDisablePush,
	}: {
		installAvailable: boolean
		pushEnabled: boolean
		subscriptionCount: number
		busy?: boolean
		onInstall: () => void
		onEnablePush: () => void
		onDisablePush: () => void
	} = $props()
</script>

<ContentPanel>
	{#snippet header()}
		<h2 class="flex items-center gap-2 text-base font-semibold">
			<span class="h-1.5 w-1.5 rounded-full bg-info"></span>
			App & Push
		</h2>
	{/snippet}
	<div class="grid gap-x-6 gap-y-0 divide-y divide-base-300/50 sm:grid-cols-2 sm:divide-y-0">
		<!-- Install -->
		<div class="flex items-center justify-between gap-4 py-3.5 first:pt-0 sm:py-2">
			<div>
				<p class="text-sm font-medium">Install App</p>
				<p class="mt-0.5 text-xs text-base-content/55">Standalone desktop & mobile app</p>
			</div>
			<button
				class="btn btn-primary btn-sm btn-outline"
				type="button"
				onclick={onInstall}
				disabled={!installAvailable}
			>
				{installAvailable ? 'Install' : 'Installed'}
			</button>
		</div>

		<!-- Push -->
		<div class="flex items-center justify-between gap-4 py-3.5 last:pb-0 sm:py-2">
			<div>
				<p class="text-sm font-medium">Push Notifications</p>
				<p class="mt-0.5 text-xs text-base-content/55">
					{pushEnabled ? 'Enabled' : 'Disabled'} &middot; {subscriptionCount} subscription{subscriptionCount !== 1 ? 's' : ''}
				</p>
			</div>
			<div class="flex gap-1.5">
				{#if pushEnabled}
					<button class="btn btn-ghost btn-sm" type="button" onclick={onDisablePush} disabled={busy}>Disable</button>
				{:else}
					<button class="btn btn-success btn-sm" type="button" onclick={onEnablePush} disabled={busy}>Enable</button>
				{/if}
			</div>
		</div>
	</div>
</ContentPanel>
