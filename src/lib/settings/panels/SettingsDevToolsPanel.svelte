<script lang="ts">
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import { listNotificationFeed, markNotification, sendTestNotification } from '$lib/notifications';

	type NotificationRow = Awaited<ReturnType<typeof listNotificationFeed>>[number];

	let {
		notifications,
		busy = false,
		onStatusMessage,
		onRefresh,
	}: {
		notifications: NotificationRow[];
		busy?: boolean;
		onStatusMessage?: (msg: string) => void;
		onRefresh?: () => void | Promise<void>;
	} = $props();

	let testTitle = $state('Task needs review');
	let testBody = $state('A delegated task is waiting for your approval.');
	let testUrl = $state('/chat');
	let internalBusy = $state(false);

	const isBusy = $derived(busy || internalBusy);

	async function sendTest() {
		if (isBusy) return;
		internalBusy = true;
		try {
			await sendTestNotification({
				title: testTitle,
				body: testBody,
				url: testUrl,
				tag: 'phase7-test',
			});
			onStatusMessage?.('Test notification sent.');
			await onRefresh?.();
		} catch (err) {
			onStatusMessage?.(
				`Test failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			internalBusy = false;
		}
	}

	async function markRead(notificationId: string, read: boolean) {
		try {
			await markNotification({ notificationId, read });
		} catch (err) {
			onStatusMessage?.(
				`Notification update failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}
		await onRefresh?.();
	}
</script>

<ContentPanel>
	{#snippet header()}
		<h2 class="flex items-center gap-2 text-base font-semibold">
			<span class="h-1.5 w-1.5 rounded-full bg-error"></span>
			Developer Tools
		</h2>
	{/snippet}
	<div class="space-y-3">
		<!-- Test Notification -->
		<div class="rounded-md bg-base-200/40 px-4 py-3.5">
			<p class="mb-2.5 text-sm font-medium">Send Test Notification</p>
			<div class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
				<input class="input input-bordered input-sm" bind:value={testTitle} placeholder="Title" />
				<input class="input input-bordered input-sm" bind:value={testBody} placeholder="Body" />
				<button class="btn btn-secondary btn-sm" type="button" onclick={sendTest} disabled={isBusy}>Send</button>
			</div>
		</div>

		<!-- Notification Feed -->
		<div class="rounded-md bg-base-200/40 px-4 py-3.5">
			<p class="mb-2 text-sm font-medium">Notification Feed</p>
			{#if notifications.length === 0}
				<p class="text-xs text-base-content/55">No notifications recorded yet.</p>
			{:else}
				<div class="space-y-1.5">
					{#each notifications as item (item.id)}
						<div class="flex items-start justify-between gap-3 rounded-md bg-base-300/30 px-3 py-2">
							<div class="min-w-0">
								<p class="truncate text-sm font-medium">{item.title}</p>
								<p class="truncate text-xs text-base-content/60">{item.body}</p>
								<p class="mt-0.5 text-[10px] text-base-content/45">{new Date(item.createdAt).toLocaleString()}</p>
							</div>
							{#if item.read}
								<button class="btn btn-ghost btn-xs shrink-0" type="button" onclick={() => markRead(item.id, false)}>Unread</button>
							{:else}
								<button class="btn btn-ghost btn-xs shrink-0" type="button" onclick={() => markRead(item.id, true)}>Read</button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</ContentPanel>
