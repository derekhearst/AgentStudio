<svelte:head><title>Settings | AgentStudio</title></svelte:head>

<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import {
		getPushPublicKey,
		listNotificationFeed,
		listSubscriptions,
		markNotification,
		sendTestNotification,
		subscribePush,
		unsubscribePush
	} from '$lib/notifications';
	import { getSettings, resetAppSettings, updateAppSettings } from '$lib/settings';
	import ModelSelector from '$lib/models/ModelSelector.svelte';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type NotificationRow = Awaited<ReturnType<typeof listNotificationFeed>>[number];
	type SubscriptionRow = Awaited<ReturnType<typeof listSubscriptions>>[number];
	type SettingsRow = Awaited<ReturnType<typeof getSettings>>;

	type BeforeInstallPromptEvent = Event & {
		prompt: () => Promise<void>;
		userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
	};

	let installPromptEvent = $state<BeforeInstallPromptEvent | null>(null);
	let notifications = $state<NotificationRow[]>([]);
	let subscriptions = $state<SubscriptionRow[]>([]);
	let pushEnabled = $state(false);
	let busy = $state(false);
	let installAvailable = $derived(installPromptEvent !== null);
	let testTitle = $state('Task needs review');
	let testBody = $state('A delegated task is waiting for your approval.');
	let testUrl = $state('/tasks');
	let statusMessage = $state('');
	let settings = $state<SettingsRow | null>(null);
	let searchQuery = $state('');

	const searchLower = $derived(searchQuery.toLowerCase().trim());

	const sections = [
		{ id: 'model', keywords: 'model ai default transcription voice audio tool approval dream aggressiveness frequency auto run' },
		{ id: 'prompt', keywords: 'system prompt custom instructions' },
		{ id: 'context', keywords: 'context window reserved response compact threshold compaction model tools' },
		{ id: 'notifications', keywords: 'notification task completed needs input dream summary agent errors' },
		{ id: 'budget', keywords: 'budget daily monthly limit cost' },
		{ id: 'app', keywords: 'app push install pwa notifications subscribe' },
		{ id: 'devtools', keywords: 'developer tools test notification feed debug' },
	] as const;

	function isVisible(id: (typeof sections)[number]['id']) {
		if (!searchLower) return true;
		const section = sections.find((s) => s.id === id);
		return section ? section.keywords.includes(searchLower) : true;
	}

	onMount(() => {
		void refresh();
		if (!browser) return;

		const onInstallPrompt = (event: Event) => {
			event.preventDefault();
			installPromptEvent = event as BeforeInstallPromptEvent;
		};

		window.addEventListener('beforeinstallprompt', onInstallPrompt);
		return () => window.removeEventListener('beforeinstallprompt', onInstallPrompt);
	});

	async function refresh() {
		const [feed, subs, appSettings] = await Promise.all([
			listNotificationFeed(),
			listSubscriptions(),
			getSettings()
		]);
		notifications = feed;
		subscriptions = subs;
		settings = appSettings;
		pushEnabled = subs.length > 0;
	}

	function applyTheme(theme: 'AgentStudio-night') {
		if (!browser) return;
		document.documentElement.setAttribute('data-theme', theme);
		localStorage.setItem('AgentStudio-theme', theme);
	}

	async function saveSettings() {
		if (!settings || busy) return;
		busy = true;
		statusMessage = '';
		try {
			const updated = await updateAppSettings({
				defaultModel: settings.defaultModel,
				transcriptionModel: settings.transcriptionModel,
				theme: 'AgentStudio-night',
				notificationPrefs: settings.notificationPrefs,
				dreamConfig: settings.dreamConfig,
				budgetConfig: settings.budgetConfig,
				contextConfig: settings.contextConfig,
				toolConfig: settings.toolConfig,
				systemPrompt: settings.systemPrompt,
			});
			settings = updated;
			applyTheme('AgentStudio-night');
			statusMessage = 'Settings saved.';
		} finally {
			busy = false;
		}
	}

	async function resetSettingsToDefault() {
		if (busy) return;
		busy = true;
		statusMessage = '';
		try {
			const updated = await resetAppSettings();
			settings = updated;
			applyTheme('AgentStudio-night');
			statusMessage = 'Settings reset to defaults.';
		} finally {
			busy = false;
		}
	}

	function base64ToUint8Array(value: string) {
		const padding = '='.repeat((4 - (value.length % 4)) % 4);
		const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
		const raw = atob(base64);
		const output = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i += 1) {
			output[i] = raw.charCodeAt(i);
		}
		return output;
	}

	async function enablePush() {
		if (!browser || !('serviceWorker' in navigator) || !('PushManager' in window)) {
			statusMessage = 'Push is not supported in this browser.';
			return;
		}
		busy = true;
		statusMessage = '';
		try {
			const permission = await Notification.requestPermission();
			if (permission !== 'granted') {
				statusMessage = 'Notification permission was not granted.';
				return;
			}

			const registration = await navigator.serviceWorker.ready;
			const { publicKey } = await getPushPublicKey();
			const current = await registration.pushManager.getSubscription();
			const subscription =
				current ??
				(await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: base64ToUint8Array(publicKey)
				}));

			const json = subscription.toJSON();
			if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
				statusMessage = 'Subscription payload is incomplete.';
				return;
			}

			await subscribePush({
				endpoint: json.endpoint,
				keys: {
					p256dh: json.keys.p256dh,
					auth: json.keys.auth
				},
				deviceLabel: navigator.userAgent.slice(0, 110)
			});

			statusMessage = 'Push notifications enabled.';
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function disablePush() {
		if (!browser || !('serviceWorker' in navigator)) return;
		busy = true;
		statusMessage = '';
		try {
			const registration = await navigator.serviceWorker.ready;
			const existing = await registration.pushManager.getSubscription();
			if (existing) {
				const endpoint = existing.endpoint;
				await existing.unsubscribe();
				await unsubscribePush({ endpoint });
			}
			statusMessage = 'Push notifications disabled.';
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function sendTest() {
		if (busy) return;
		busy = true;
		statusMessage = '';
		try {
			await sendTestNotification({
				title: testTitle,
				body: testBody,
				url: testUrl,
				tag: 'phase7-test'
			});
			statusMessage = 'Test notification sent.';
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function markRead(notificationId: string, read: boolean) {
		await markNotification({ notificationId, read });
		await refresh();
	}

	async function promptInstall() {
		if (!installPromptEvent) return;
		await installPromptEvent.prompt();
		await installPromptEvent.userChoice;
		installPromptEvent = null;
	}

	function updateDreamAutoRun(autoRun: boolean) {
		if (!settings) return;
		settings = {
			...settings,
			dreamConfig: {
				...settings.dreamConfig,
				autoRun
			}
		};
	}
</script>

<section class="flex min-h-full flex-col">
	<!-- ─── Fixed Header ─── -->
	<ContentPanel>
		{#snippet header()}
			<div class="min-w-0">
				<h1 class="text-xl font-bold sm:text-3xl">Settings</h1>
				<p class="text-xs text-base-content/70 sm:text-sm">
					{#if statusMessage}
						<span class="text-success">{statusMessage}</span>
					{:else}
						Configure models, prompts, notifications, and system behavior.
					{/if}
				</p>
			</div>
		{/snippet}
		{#snippet actions()}
			<button class="btn btn-ghost btn-sm" type="button" onclick={resetSettingsToDefault} disabled={busy}>Reset</button>
			<button class="btn btn-primary btn-sm" type="button" onclick={saveSettings} disabled={busy}>
				{#if busy}
					<span class="loading loading-spinner loading-xs"></span>
				{/if}
				Save
			</button>
		{/snippet}
	</ContentPanel>

	<!-- ─── Search (fixed below header) ─── -->
	<div class="mt-2 mb-1 px-1 sm:px-0">
		<input
			type="text"
			class="input input-bordered input-sm w-full"
			placeholder="Search settings…"
			bind:value={searchQuery}
		/>
	</div>

	<!-- ─── Scrollable Settings ─── -->
	<div class="mt-2 min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-2xl space-y-6 px-1 pb-6 sm:space-y-10 sm:px-0">

	{#if settings}
		<!-- ════════════════════════════════════════════════
		     MODEL & AI
		     ════════════════════════════════════════════════ -->
		{#if isVisible('model')}
		<section>
			<p class="mb-3 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-widest text-base-content/40">
				<span class="inline-block h-1.5 w-1.5 rounded-full bg-primary"></span>Model & AI
			</p>
			<div class="rounded-xl bg-base-200/40 px-3 sm:px-4">
				<!-- Default Model -->
				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-3.5">
					<div>
						<p class="text-sm font-medium">Default Model</p>
						<p class="mt-0.5 text-xs text-base-content/40">Primary model for new conversations</p>
					</div>
					<div class="w-full sm:w-64">
						<ModelSelector
							value={settings.defaultModel}
							showChevron={false}
							showBrowseBadge={false}
							onchange={(id: string) => {
								if (settings) settings.defaultModel = id;
							}}
						/>
					</div>
				</div>
				<div class="border-t border-base-content/[.06]"></div>

				<!-- Transcription Model -->
				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-3.5">
					<div>
						<p class="text-sm font-medium">Transcription Model</p>
						<p class="mt-0.5 text-xs text-base-content/40">Model for voice-to-text (must support audio input)</p>
					</div>
					<div class="w-full sm:w-64">
						<ModelSelector
							value={settings.transcriptionModel}
							showChevron={false}
							showBrowseBadge={false}
							requireInputModality="audio"
							onchange={(id: string) => {
								if (settings) settings.transcriptionModel = id;
							}}
						/>
					</div>
				</div>
				<div class="border-t border-base-content/[.06]"></div>

				<!-- Tool Approval Mode -->
				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-3.5">
					<div>
						<p class="text-sm font-medium">Tool Approval</p>
						<p class="mt-0.5 text-xs text-base-content/40">Require permission before the agent runs tools</p>
					</div>
					<select
						class="select select-bordered select-sm w-full sm:w-40"
						value={settings.toolConfig?.approvalMode ?? 'auto'}
						onchange={(e) => {
							if (!settings) return;
							const mode = (e.currentTarget as HTMLSelectElement).value as 'auto' | 'confirm' | 'plan';
							settings = {
								...settings,
								toolConfig: { ...settings.toolConfig, approvalMode: mode },
							};
						}}
					>
						<option value="auto">Auto-approve</option>
						<option value="confirm">Ask every time</option>
						<option value="plan">Plan first</option>
					</select>
				</div>
				<div class="border-t border-base-content/[.06]"></div>

				<!-- Dream Auto Run -->
				<div class="flex items-center justify-between gap-4 py-3.5">
					<div>
						<p class="text-sm font-medium">Dream Auto Run</p>
						<p class="mt-0.5 text-xs text-base-content/40">Automatically run dream cycles on schedule</p>
					</div>
					<input
						type="checkbox"
						class="toggle toggle-primary toggle-sm"
						bind:checked={settings.dreamConfig.autoRun}
						onchange={(e) => updateDreamAutoRun((e.currentTarget as HTMLInputElement).checked)}
					/>
				</div>
				<div class="border-t border-base-content/[.06]"></div>

				<!-- Dream Frequency -->
				<div class="flex items-center justify-between gap-4 py-3.5">
					<div>
						<p class="text-sm font-medium">Dream Frequency</p>
						<p class="mt-0.5 text-xs text-base-content/40">Hours between automatic dream cycles</p>
					</div>
					<div class="flex items-center gap-1.5">
						<input
							type="number"
							class="input input-bordered input-sm w-20 text-right font-mono"
							min="1"
							max="720"
							bind:value={settings.dreamConfig.frequencyHours}
						/>
						<span class="text-xs text-base-content/30">hrs</span>
					</div>
				</div>
				<div class="border-t border-base-content/[.06]"></div>

				<!-- Dream Aggressiveness -->
				<div class="py-3.5">
					<div class="flex items-center justify-between">
						<p class="text-sm font-medium">Aggressiveness</p>
						<span class="rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary">{settings.dreamConfig.aggressiveness.toFixed(2)}</span>
					</div>
					<input
						type="range"
						min="0"
						max="1"
						step="0.05"
						class="range range-primary range-xs mt-3"
						bind:value={settings.dreamConfig.aggressiveness}
					/>
				</div>
			</div>
		</section>

		{/if}

		<!-- ════════════════════════════════════════════════
		     SYSTEM PROMPT
		     ════════════════════════════════════════════════ -->
		{#if isVisible('prompt')}
		<section>
			<p class="mb-3 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-widest text-base-content/40">
				<span class="inline-block h-1.5 w-1.5 rounded-full bg-primary"></span>System Prompt
			</p>
			<div class="rounded-xl bg-base-200/40 px-3 sm:px-4">
				<div class="py-3.5">
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm font-medium">Custom System Prompt</p>
							<p class="mt-0.5 text-xs text-base-content/40">Prepended to every chat conversation. Leave empty to use defaults only.</p>
						</div>
					</div>
					<textarea
						class="textarea textarea-bordered mt-3 w-full font-mono text-xs leading-relaxed"
						rows="6"
						maxlength="12000"
						placeholder="e.g. You are AgentStudio, a helpful AI assistant with access to tools..."
						bind:value={settings.systemPrompt}
					></textarea>
					<p class="mt-1 text-right text-[10px] text-base-content/30">{settings.systemPrompt?.length ?? 0} / 12000</p>
				</div>
			</div>
		</section>

		{/if}

		<!-- ════════════════════════════════════════════════
		     CONTEXT WINDOW
		     ════════════════════════════════════════════════ -->
		{#if isVisible('context')}
		<section>
			<p class="mb-3 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-widest text-base-content/40">
				<span class="inline-block h-1.5 w-1.5 rounded-full bg-secondary"></span>Context Window
			</p>
			<div class="rounded-xl bg-base-200/40 px-4">
				<!-- Reserved Response -->
				<div class="py-3.5">
					<div class="flex items-center justify-between">
						<p class="text-sm font-medium">Reserved Response</p>
						<span class="rounded-md bg-secondary/10 px-2 py-0.5 font-mono text-xs text-secondary">{settings.contextConfig.reservedResponsePct.toFixed(0)}%</span>
					</div>
					<input
						type="range"
						min="10"
						max="40"
						step="1"
						class="range range-secondary range-xs mt-3"
						bind:value={settings.contextConfig.reservedResponsePct}
					/>
					<p class="mt-1.5 text-xs text-base-content/35">Size of the striped reserved segment in the context bar</p>
				</div>
				<div class="border-t border-base-content/[.06]"></div>

				<!-- Auto-Compact Threshold -->
				<div class="py-3.5">
					<div class="flex items-center justify-between">
						<p class="text-sm font-medium">Auto-Compact Threshold</p>
						<span class="rounded-md bg-secondary/10 px-2 py-0.5 font-mono text-xs text-secondary">{settings.contextConfig.autoCompactThresholdPct.toFixed(0)}%</span>
					</div>
					<input
						type="range"
						min="40"
						max="95"
						step="1"
						class="range range-secondary range-xs mt-3"
						bind:value={settings.contextConfig.autoCompactThresholdPct}
					/>
					<p class="mt-1.5 text-xs text-base-content/35">Auto-compaction triggers when a model switch would exceed this</p>
				</div>
				<div class="border-t border-base-content/[.06]"></div>

				<!-- Compaction Model -->
				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-3.5">
					<div>
						<p class="text-sm font-medium">Compaction Model</p>
						<p class="mt-0.5 text-xs text-base-content/40">Model used to summarize conversations during auto-compaction</p>
					</div>
					<div class="w-full sm:w-64">
						<ModelSelector
							value={settings.contextConfig.compactionModel}
							showChevron={false}
							showBrowseBadge={false}
							onchange={(id: string) => {
								if (settings) settings.contextConfig.compactionModel = id;
							}}
						/>
					</div>
				</div>
				<div class="border-t border-base-content/[.06]"></div>
				<div class="py-3.5">
					<p class="text-sm font-medium">Tool Availability</p>
					<p class="mt-0.5 text-xs text-base-content/40">Manage built-in tool toggles from the Tools page.</p>
				</div>
			</div>
		</section>

		{/if}

		<!-- ════════════════════════════════════════════════
		     NOTIFICATIONS
		     ════════════════════════════════════════════════ -->
		{#if isVisible('notifications')}
		<section>
			<p class="mb-3 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-widest text-base-content/40">
				<span class="inline-block h-1.5 w-1.5 rounded-full bg-accent"></span>Notifications
			</p>
			<div class="rounded-xl bg-base-200/40 px-4">
				<div class="flex items-center justify-between gap-4 py-3">
					<p class="text-sm font-medium">Task completed</p>
					<input type="checkbox" class="toggle toggle-accent toggle-sm" bind:checked={settings.notificationPrefs.taskCompleted} />
				</div>
				<div class="border-t border-base-content/[.06]"></div>
				<div class="flex items-center justify-between gap-4 py-3">
					<p class="text-sm font-medium">Needs input</p>
					<input type="checkbox" class="toggle toggle-accent toggle-sm" bind:checked={settings.notificationPrefs.needsInput} />
				</div>
				<div class="border-t border-base-content/[.06]"></div>
				<div class="flex items-center justify-between gap-4 py-3">
					<p class="text-sm font-medium">Dream summary</p>
					<input type="checkbox" class="toggle toggle-accent toggle-sm" bind:checked={settings.notificationPrefs.dreamSummary} />
				</div>
				<div class="border-t border-base-content/[.06]"></div>
				<div class="flex items-center justify-between gap-4 py-3">
					<p class="text-sm font-medium">Agent errors</p>
					<input type="checkbox" class="toggle toggle-accent toggle-sm" bind:checked={settings.notificationPrefs.agentErrors} />
				</div>
			</div>
		</section>

		{/if}

		<!-- ════════════════════════════════════════════════
		     BUDGET
		     ════════════════════════════════════════════════ -->
		{#if isVisible('budget')}
		<section>
			<p class="mb-1.5 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-widest text-base-content/40">
				<span class="inline-block h-1.5 w-1.5 rounded-full bg-warning"></span>Budget
			</p>
			<p class="mb-3 pl-4 text-xs text-base-content/35">Alerts trigger at 80 % and 100 %</p>
			<div class="rounded-xl bg-base-200/40 px-4">
				<div class="flex items-center justify-between gap-4 py-3.5">
					<p class="text-sm font-medium">Daily limit</p>
					<div class="flex items-center gap-1.5">
						<span class="text-xs text-base-content/30">$</span>
						<input
							type="number"
							class="input input-bordered input-sm w-28 text-right font-mono"
							min="0"
							step="0.01"
							placeholder="No limit"
							value={settings.budgetConfig?.dailyLimit ?? ''}
							onchange={(e) => {
								if (!settings) return;
								const val = (e.currentTarget as HTMLInputElement).value;
								settings = { ...settings, budgetConfig: { ...settings.budgetConfig, dailyLimit: val ? Number(val) : null } };
							}}
						/>
					</div>
				</div>
				<div class="border-t border-base-content/[.06]"></div>
				<div class="flex items-center justify-between gap-4 py-3.5">
					<p class="text-sm font-medium">Monthly limit</p>
					<div class="flex items-center gap-1.5">
						<span class="text-xs text-base-content/30">$</span>
						<input
							type="number"
							class="input input-bordered input-sm w-28 text-right font-mono"
							min="0"
							step="0.01"
							placeholder="No limit"
							value={settings.budgetConfig?.monthlyLimit ?? ''}
							onchange={(e) => {
								if (!settings) return;
								const val = (e.currentTarget as HTMLInputElement).value;
								settings = { ...settings, budgetConfig: { ...settings.budgetConfig, monthlyLimit: val ? Number(val) : null } };
							}}
						/>
					</div>
				</div>
			</div>
		</section>
		{/if}
	{/if}

	<!-- ════════════════════════════════════════════════
	     APP & PUSH
	     ════════════════════════════════════════════════ -->
	{#if isVisible('app')}
	<section>
		<p class="mb-3 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-widest text-base-content/40">
			<span class="inline-block h-1.5 w-1.5 rounded-full bg-info"></span>App & Push
		</p>
		<div class="rounded-xl bg-base-200/40 px-4">
			<!-- Install -->
			<div class="flex items-center justify-between gap-4 py-3.5">
				<div>
					<p class="text-sm font-medium">Install App</p>
					<p class="mt-0.5 text-xs text-base-content/40">Standalone desktop & mobile app</p>
				</div>
				<button
					class="btn btn-primary btn-sm btn-outline"
					type="button"
					onclick={promptInstall}
					disabled={!installAvailable}
				>
					{installAvailable ? 'Install' : 'Installed'}
				</button>
			</div>
			<div class="border-t border-base-content/[.06]"></div>

			<!-- Push -->
			<div class="flex items-center justify-between gap-4 py-3.5">
				<div>
					<p class="text-sm font-medium">Push Notifications</p>
					<p class="mt-0.5 text-xs text-base-content/40">
						{pushEnabled ? 'Enabled' : 'Disabled'} &middot; {subscriptions.length} subscription{subscriptions.length !== 1 ? 's' : ''}
					</p>
				</div>
				<div class="flex gap-1.5">
					{#if pushEnabled}
						<button class="btn btn-ghost btn-sm" type="button" onclick={disablePush} disabled={busy}>Disable</button>
					{:else}
						<button class="btn btn-success btn-sm" type="button" onclick={enablePush} disabled={busy}>Enable</button>
					{/if}
				</div>
			</div>
		</div>
	</section>

	{/if}

	<!-- ════════════════════════════════════════════════
	     DEVELOPER TOOLS
	     ════════════════════════════════════════════════ -->
	{#if isVisible('devtools')}
	<section>
		<p class="mb-3 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-widest text-base-content/40">
			<span class="inline-block h-1.5 w-1.5 rounded-full bg-error"></span>Developer Tools
		</p>
		<div class="space-y-3">
			<!-- Test Notification -->
			<div class="rounded-xl bg-base-200/40 px-4 py-3.5">
				<p class="mb-2.5 text-sm font-medium">Send Test Notification</p>
				<div class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
					<input class="input input-bordered input-sm" bind:value={testTitle} placeholder="Title" />
					<input class="input input-bordered input-sm" bind:value={testBody} placeholder="Body" />
					<button class="btn btn-secondary btn-sm" type="button" onclick={sendTest} disabled={busy}>Send</button>
				</div>
			</div>

			<!-- Notification Feed -->
			<div class="rounded-xl bg-base-200/40 px-4 py-3.5">
				<p class="mb-2 text-sm font-medium">Notification Feed</p>
				{#if notifications.length === 0}
					<p class="text-xs text-base-content/40">No notifications recorded yet.</p>
				{:else}
					<div class="space-y-1.5">
						{#each notifications as item (item.id)}
							<div class="flex items-start justify-between gap-3 rounded-lg bg-base-300/30 px-3 py-2">
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{item.title}</p>
									<p class="truncate text-xs text-base-content/50">{item.body}</p>
									<p class="mt-0.5 text-[10px] text-base-content/30">{new Date(item.createdAt).toLocaleString()}</p>
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
	</section>
	{/if}

	</div><!-- end max-w-2xl -->
	</div><!-- end scroll -->
</section>


