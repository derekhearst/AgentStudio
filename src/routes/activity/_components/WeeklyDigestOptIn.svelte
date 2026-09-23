<script lang="ts">
	/**
	 * #38 — opt in to getting the strip's numbers every Monday.
	 *
	 * The digest is an ordinary maintenance automation (prompt `{{usage_digest}}`) rendered by
	 * code, so it costs nothing to send. Nothing creates it on deploy; this button is the only
	 * way in besides writing the automation by hand. Turning it off, changing the day or
	 * deleting it happen on /automations like any other automation.
	 */
	import { onMount } from 'svelte';
	import { listAutomationsQuery } from '$lib/automations';
	import { enableUsageDigestCommand, getUsageDigestAutomation } from '$lib/costs/usage-digest.remote';
	import { USAGE_DIGEST_CRON } from '$lib/costs/usage-digest';

	type DigestAutomation = Awaited<ReturnType<typeof getUsageDigestAutomation>>;

	let automation = $state<DigestAutomation>(null);
	let loaded = $state(false);
	let saving = $state(false);
	let message = $state<string | null>(null);

	onMount(() => {
		void load();
	});

	async function load() {
		try {
			automation = await getUsageDigestAutomation();
		} catch {
			automation = null;
		} finally {
			loaded = true;
		}
	}

	function browserTimeZone(): string | undefined {
		try {
			return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
		} catch {
			return undefined;
		}
	}

	async function enable(outputTarget: 'review_inbox' | 'chat_session') {
		saving = true;
		message = null;
		try {
			await enableUsageDigestCommand({ outputTarget, timezone: browserTimeZone() });
			await Promise.all([getUsageDigestAutomation().refresh(), listAutomationsQuery().refresh()]);
			automation = await getUsageDigestAutomation();
		} catch {
			message = 'Could not turn on the weekly digest. Try again, or create it on Automations.';
		} finally {
			saving = false;
		}
	}
</script>

<div class="shrink-0 text-[11px]" data-testid="weekly-digest">
	{#if !loaded}
		<span class="text-base-content/40">…</span>
	{:else if automation?.enabled}
		<p class="text-base-content/60" data-testid="weekly-digest-on">
			Weekly digest on ·
			{automation.cronExpression === USAGE_DIGEST_CRON ? 'Mondays 9:00' : automation.cronExpression}
			({automation.timezone}) to the
			{automation.outputTarget === 'review_inbox' ? 'review inbox' : 'chat'} ·
			<a href="/automations" class="link">Manage</a>
		</p>
	{:else}
		<div class="flex flex-wrap items-center gap-1.5">
			<span class="text-base-content/60">Get this every Monday, no model call:</span>
			<div class="join">
				<button
					type="button"
					class="btn btn-xs join-item"
					disabled={saving}
					onclick={() => enable('review_inbox')}
					data-testid="weekly-digest-enable-inbox"
				>
					Review inbox
				</button>
				<button
					type="button"
					class="btn btn-xs join-item"
					disabled={saving}
					onclick={() => enable('chat_session')}
					data-testid="weekly-digest-enable-chat"
				>
					Chat
				</button>
			</div>
		</div>
		{#if message}
			<p class="mt-1 text-error">{message}</p>
		{/if}
	{/if}
</div>
