<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte'

	type NotificationPrefs = {
		taskCompleted: boolean
		needsInput: boolean
		agentErrors: boolean
	}

	let { notificationPrefs }: { notificationPrefs: NotificationPrefs } = $props()

	/**
	 * What each switch covers. Every server-side notification goes through `notifyUser`,
	 * which reads these switches. Shown as the row's tooltip and read out as the switch's
	 * description, so the panel keeps its one-line rows.
	 */
	const DESCRIPTIONS: Record<keyof NotificationPrefs, string> = {
		taskCompleted: 'A research report is ready',
		needsInput: 'A chat has waited a minute for an approval or an answer',
		agentErrors: 'An automation keeps failing, or CI fails on a pull request an agent opened',
	}
</script>

<ContentPanel>
	{#snippet header()}
		<h2 class="flex items-center gap-2 text-base font-semibold">
			<span class="h-1.5 w-1.5 rounded-full bg-accent"></span>
			Notifications
		</h2>
	{/snippet}
	<!--
		Each row is a <label>, not a <div>: three identical unlabelled checkboxes, announced as
		nothing at all before this. Wrapping also makes the whole row a hit target.
	-->
	<!-- Outside the labels, so each switch's name stays just its label. -->
	<div class="sr-only">
		<span id="notify-taskCompleted-desc">{DESCRIPTIONS.taskCompleted}</span>
		<span id="notify-needsInput-desc">{DESCRIPTIONS.needsInput}</span>
		<span id="notify-agentErrors-desc">{DESCRIPTIONS.agentErrors}</span>
	</div>
	<div class="grid gap-x-6 gap-y-0 divide-y divide-base-300/50 sm:grid-cols-3 sm:divide-y-0">
		<label class="flex cursor-pointer items-center justify-between gap-4 py-3 first:pt-0 sm:py-2" title={DESCRIPTIONS.taskCompleted}>
			<span class="text-sm font-medium">Task completed</span>
			<input
				type="checkbox"
				class="toggle toggle-accent toggle-sm"
				aria-describedby="notify-taskCompleted-desc"
				bind:checked={notificationPrefs.taskCompleted}
			/>
		</label>
		<label class="flex cursor-pointer items-center justify-between gap-4 py-3 sm:py-2" title={DESCRIPTIONS.needsInput}>
			<span class="text-sm font-medium">Needs input</span>
			<input
				type="checkbox"
				class="toggle toggle-accent toggle-sm"
				aria-describedby="notify-needsInput-desc"
				bind:checked={notificationPrefs.needsInput}
			/>
		</label>
		<label class="flex cursor-pointer items-center justify-between gap-4 py-3 last:pb-0 sm:py-2" title={DESCRIPTIONS.agentErrors}>
			<span class="text-sm font-medium">Agent errors</span>
			<input
				type="checkbox"
				class="toggle toggle-accent toggle-sm"
				aria-describedby="notify-agentErrors-desc"
				bind:checked={notificationPrefs.agentErrors}
			/>
		</label>
	</div>
</ContentPanel>
