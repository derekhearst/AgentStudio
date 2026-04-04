<svelte:head><title>Settings | DrokBot</title></svelte:head>

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
	} from '$lib/notifications/notifications.remote';
	import { getSettings, resetAppSettings, updateAppSettings } from '$lib/settings/settings.remote';
	import ModelSelector from '$lib/components/ui/ModelSelector.svelte';

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

	function applyTheme(theme: 'drokbot' | 'drokbot-night') {
		if (!browser) return;
		document.documentElement.setAttribute('data-theme', theme);
		localStorage.setItem('drokbot-theme', theme);
	}

	async function saveSettings() {
		if (!settings || busy) return;
		busy = true;
		statusMessage = '';
		try {
			const updated = await updateAppSettings({
				defaultModel: settings.defaultModel,
				theme: settings.theme as 'drokbot' | 'drokbot-night',
				notificationPrefs: settings.notificationPrefs,
				dreamConfig: settings.dreamConfig,
				budgetConfig: settings.budgetConfig,
			});
			settings = updated;
			applyTheme(updated.theme as 'drokbot' | 'drokbot-night');
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
			applyTheme(updated.theme as 'drokbot' | 'drokbot-night');
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

<section class="space-y-5">
	<header class="rounded-2xl border border-base-300 bg-base-100 p-4">
		<h1 class="text-3xl font-bold">Settings</h1>
		<p class="text-sm text-base-content/70">
			Phase 8 settings plus Phase 7 controls for PWA install and push notifications.
		</p>
	</header>

	{#if settings}
		<section class="rounded-2xl border border-base-300 bg-base-100 p-4">
			<h2 class="text-lg font-semibold">General Preferences</h2>
			<div class="mt-3 grid gap-3 md:grid-cols-2">
				<div class="form-control">
					<span class="label-text">Default Model</span>
					<ModelSelector value={settings.defaultModel} onchange={(id: string) => { if (settings) settings.defaultModel = id }} />
				</div>
				<label class="form-control">
					<span class="label-text">Theme</span>
					<select class="select select-bordered" bind:value={settings.theme}>
						<option value="drokbot">drokbot</option>
						<option value="drokbot-night">drokbot-night</option>
					</select>
				</label>
				<label class="form-control">
					<span class="label-text">Dream Auto Run</span>
					<select
						class="select select-bordered"
						value={settings.dreamConfig.autoRun ? 'true' : 'false'}
						onchange={(e) => {
							updateDreamAutoRun((e.currentTarget as HTMLSelectElement).value === 'true');
						}}
					>
						<option value="true">enabled</option>
						<option value="false">disabled</option>
					</select>
				</label>
				<label class="form-control">
					<span class="label-text">Dream Frequency (hours)</span>
					<input
						type="number"
						class="input input-bordered"
						min="1"
						max="720"
						bind:value={settings.dreamConfig.frequencyHours}
					/>
				</label>
				<label class="form-control md:col-span-2">
					<span class="label-text">Dream Aggressiveness ({settings.dreamConfig.aggressiveness.toFixed(2)})</span>
					<input
						type="range"
						min="0"
						max="1"
						step="0.05"
						class="range"
						bind:value={settings.dreamConfig.aggressiveness}
					/>
				</label>
			</div>

			<div class="mt-4">
				<h3 class="font-medium">Notification Preferences</h3>
				<div class="mt-2 grid gap-2 md:grid-cols-2">
					<label class="label cursor-pointer justify-start gap-2">
						<input type="checkbox" class="checkbox" bind:checked={settings.notificationPrefs.taskCompleted} />
						<span class="label-text">Task completed alerts</span>
					</label>
					<label class="label cursor-pointer justify-start gap-2">
						<input type="checkbox" class="checkbox" bind:checked={settings.notificationPrefs.needsInput} />
						<span class="label-text">Needs input alerts</span>
					</label>
					<label class="label cursor-pointer justify-start gap-2">
						<input type="checkbox" class="checkbox" bind:checked={settings.notificationPrefs.dreamSummary} />
						<span class="label-text">Dream summary alerts</span>
					</label>
					<label class="label cursor-pointer justify-start gap-2">
						<input type="checkbox" class="checkbox" bind:checked={settings.notificationPrefs.agentErrors} />
						<span class="label-text">Agent error alerts</span>
					</label>
				</div>
			</div>

			<div class="mt-4">
				<h3 class="font-medium">Budget Limits</h3>
				<p class="text-xs text-base-content/60">Set spending limits. Leave blank for no limit. Alerts trigger at 80% and 100%.</p>
				<div class="mt-2 grid gap-3 md:grid-cols-2">
					<label class="form-control">
						<span class="label-text">Daily Limit ($)</span>
						<input
							type="number"
							class="input input-bordered"
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
					</label>
					<label class="form-control">
						<span class="label-text">Monthly Limit ($)</span>
						<input
							type="number"
							class="input input-bordered"
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
					</label>
				</div>
			</div>

			<div class="mt-4 flex flex-wrap gap-2">
				<button class="btn btn-primary" type="button" onclick={saveSettings} disabled={busy}>Save Settings</button>
				<button class="btn btn-outline" type="button" onclick={resetSettingsToDefault} disabled={busy}>Reset Defaults</button>
			</div>
		</section>
	{/if}

	<section class="grid gap-4 lg:grid-cols-2">
		<article class="rounded-2xl border border-base-300 bg-base-100 p-4">
			<h2 class="text-lg font-semibold">App Install</h2>
			<p class="mt-1 text-sm text-base-content/70">Install DrokBot as a standalone app for desktop and mobile.</p>
			<button class="btn btn-primary mt-3" type="button" onclick={promptInstall} disabled={!installAvailable}>
				Install App
			</button>
		</article>

		<article class="rounded-2xl border border-base-300 bg-base-100 p-4">
			<h2 class="text-lg font-semibold">Push Notifications</h2>
			<p class="mt-1 text-sm text-base-content/70">
				Current status: {pushEnabled ? 'enabled' : 'disabled'} ({subscriptions.length} subscriptions)
			</p>
			<div class="mt-3 flex flex-wrap gap-2">
				<button class="btn btn-success" type="button" onclick={enablePush} disabled={busy}>Enable Push</button>
				<button class="btn btn-outline" type="button" onclick={disablePush} disabled={busy}>Disable Push</button>
			</div>
			{#if statusMessage}
				<p class="mt-2 text-sm text-base-content/70">{statusMessage}</p>
			{/if}
		</article>
	</section>

	<section class="rounded-2xl border border-base-300 bg-base-100 p-4">
		<h2 class="text-lg font-semibold">Send Test Notification</h2>
		<div class="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
			<input class="input input-bordered" bind:value={testTitle} placeholder="Title" />
			<input class="input input-bordered" bind:value={testBody} placeholder="Body" />
			<input class="input input-bordered" bind:value={testUrl} placeholder="URL" />
			<button class="btn btn-secondary" type="button" onclick={sendTest} disabled={busy}>Send</button>
		</div>
	</section>

	<section class="rounded-2xl border border-base-300 bg-base-100 p-4">
		<h2 class="text-lg font-semibold">Notification Feed</h2>
		{#if notifications.length === 0}
			<p class="mt-2 text-sm text-base-content/70">No notifications recorded yet.</p>
		{:else}
			<div class="mt-2 space-y-2">
				{#each notifications as item (item.id)}
					<article class="rounded-xl border border-base-300 bg-base-50 p-3">
						<div class="flex items-start justify-between gap-2">
							<div>
								<p class="font-medium">{item.title}</p>
								<p class="text-sm text-base-content/70">{item.body}</p>
								<p class="text-xs text-base-content/60">{new Date(item.createdAt).toLocaleString()}</p>
							</div>
							<div class="flex gap-1">
								{#if item.read}
									<button class="btn btn-xs" type="button" onclick={() => markRead(item.id, false)}>Unread</button>
								{:else}
									<button class="btn btn-xs" type="button" onclick={() => markRead(item.id, true)}>Read</button>
								{/if}
							</div>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>
</section>
