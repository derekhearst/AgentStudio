<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte'

	type NotificationPrefs = {
		taskCompleted: boolean
		needsInput: boolean
		agentErrors: boolean
	}

	let { notificationPrefs }: { notificationPrefs: NotificationPrefs } = $props()
</script>

<ContentPanel>
	{#snippet header()}
		<h2 class="flex items-center gap-2 text-base font-semibold">
			<span class="h-1.5 w-1.5 rounded-full bg-accent"></span>
			Notifications
		</h2>
	{/snippet}
	<div class="grid gap-x-6 gap-y-0 divide-y divide-base-300/50 sm:grid-cols-3 sm:divide-y-0">
		<div class="flex items-center justify-between gap-4 py-3 first:pt-0 sm:py-2">
			<p class="text-sm font-medium">Task completed</p>
			<input type="checkbox" class="toggle toggle-accent toggle-sm" bind:checked={notificationPrefs.taskCompleted} />
		</div>
		<div class="flex items-center justify-between gap-4 py-3 sm:py-2">
			<p class="text-sm font-medium">Needs input</p>
			<input type="checkbox" class="toggle toggle-accent toggle-sm" bind:checked={notificationPrefs.needsInput} />
		</div>
		<div class="flex items-center justify-between gap-4 py-3 last:pb-0 sm:py-2">
			<p class="text-sm font-medium">Agent errors</p>
			<input type="checkbox" class="toggle toggle-accent toggle-sm" bind:checked={notificationPrefs.agentErrors} />
		</div>
	</div>
</ContentPanel>
