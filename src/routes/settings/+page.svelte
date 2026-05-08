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
	import { BUILTIN_TOOLS } from '$lib/tools/tools';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import SettingsNav from '$lib/settings/SettingsNav.svelte';
	import ToolToggleChip from '$lib/settings/ToolToggleChip.svelte';
	import SettingsModelPanel from '$lib/settings/panels/SettingsModelPanel.svelte';
	import SettingsContextPanel from '$lib/settings/panels/SettingsContextPanel.svelte';
	import SettingsMemoryPanel from '$lib/settings/panels/SettingsMemoryPanel.svelte';
	import SettingsNotificationsPanel from '$lib/settings/panels/SettingsNotificationsPanel.svelte';
	import SettingsBudgetPanel from '$lib/settings/panels/SettingsBudgetPanel.svelte';
	import SettingsAppPushPanel from '$lib/settings/panels/SettingsAppPushPanel.svelte';

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
	let testUrl = $state('/chat');
	let statusMessage = $state('');
	let settings = $state<SettingsRow | null>(null);
	let searchQuery = $state('');
	let scrollRoot = $state<HTMLDivElement | null>(null);
	let activeSection = $state('model');

	const searchLower = $derived(searchQuery.toLowerCase().trim());

	const sections = [
		{ id: 'model', label: 'Model & AI', color: 'primary', keywords: 'model ai default transcription voice audio' },
		{ id: 'context', label: 'Context Window', color: 'secondary', keywords: 'context window reserved response compact threshold compaction' },
		{ id: 'tools', label: 'Tool Approval', color: 'secondary', keywords: 'tools sandbox coding skills agents image generation toggle approval' },
		{ id: 'memory', label: 'Memory Palace', color: 'accent', keywords: 'memory palace recall mining embeddings rerank topk' },
		{ id: 'notifications', label: 'Notifications', color: 'accent', keywords: 'notification task completed needs input agent errors' },
		{ id: 'budget', label: 'Budget', color: 'warning', keywords: 'budget daily monthly limit cost' },
		{ id: 'app', label: 'App & Push', color: 'info', keywords: 'app push install pwa subscribe' },
		{ id: 'devtools', label: 'Developer Tools', color: 'error', keywords: 'developer tools test notification feed debug' },
	] as const;

	type SectionId = (typeof sections)[number]['id'];

	// Tool tiers come from `toolDisclosure`: 'always' = loaded every request, 'searchable' =
	// loaded on-demand via `search_tools`. The UI groups tools by tier so operators can bulk-
	// approve a tier (e.g. require approval for every searchable tool but waive the always set).
	const TIER_META: Array<{ tierKey: 'always' | 'searchable'; label: string; description: string; alwaysOn: boolean }> = [
		{ tierKey: 'always', label: 'Always loaded', description: 'Tools shipped in the model surface on every request (web_search, ask_user, run_code, search_tools).', alwaysOn: true },
		{ tierKey: 'searchable', label: 'Searchable', description: 'The long tail of tools — loaded only after the model invokes `search_tools(query)`.', alwaysOn: false },
	];
	const toolsByTier = TIER_META
		.map(({ tierKey, label, description, alwaysOn }) => ({
			tierKey,
			tier: { label, description, alwaysOn },
			tools: BUILTIN_TOOLS.filter((tool) => tool.tier === tierKey),
		}))
		.filter((entry) => entry.tools.length > 0);

	const filteredToolsByTier = $derived.by(() => {
		if (!searchLower) return toolsByTier;
		return toolsByTier
			.map((g) => ({
				...g,
				tools: g.tools.filter(
					(t) =>
						t.name.toLowerCase().includes(searchLower) ||
						t.description.toLowerCase().includes(searchLower),
				),
			}))
			.filter((g) => g.tools.length > 0);
	});

	function isVisible(id: string) {
		if (!searchLower) return true;
		const section = sections.find((s) => s.id === id);
		const keywordMatch = section ? section.keywords.includes(searchLower) : false;
		// Tool Approval is also visible when the search matches any tool name/description
		if (id === 'tools') return keywordMatch || filteredToolsByTier.length > 0;
		return keywordMatch;
	}

	onMount(() => {
		void refresh();
		if (!browser) return;

		const onInstallPrompt = (event: Event) => {
			event.preventDefault();
			installPromptEvent = event as BeforeInstallPromptEvent;
		};

		window.addEventListener('beforeinstallprompt', onInstallPrompt);

		// Scrollspy: track which section is in view inside the scroll container.
		let observer: IntersectionObserver | null = null;
		const attachObserver = () => {
			if (!scrollRoot) return;
			observer?.disconnect();
			observer = new IntersectionObserver(
				(entries) => {
					for (const e of entries) {
						if (e.isIntersecting) {
							activeSection = (e.target as HTMLElement).id.replace('sec-', '');
						}
					}
				},
				{ root: scrollRoot, rootMargin: '-20% 0px -70% 0px', threshold: 0 },
			);
			document
				.querySelectorAll<HTMLElement>('[data-settings-section]')
				.forEach((el) => observer?.observe(el));
		};
		// Defer so DOM nodes from the {#if settings} block are mounted before observing.
		const t = setTimeout(attachObserver, 50);

		return () => {
			window.removeEventListener('beforeinstallprompt', onInstallPrompt);
			clearTimeout(t);
			observer?.disconnect();
		};
	});

	function scrollToSection(id: string) {
		document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		activeSection = id;
	}

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
				budgetConfig: settings.budgetConfig,
				contextConfig: settings.contextConfig,
				toolConfig: settings.toolConfig,
				memoryConfig: settings.memoryConfig,
			});
			settings = updated;
			applyTheme('AgentStudio-night');
			statusMessage = 'Settings saved.';
		} catch (err) {
			statusMessage = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
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
		} catch (err) {
			statusMessage = `Reset failed: ${err instanceof Error ? err.message : String(err)}`;
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
		} catch (err) {
			statusMessage = `Push enable failed: ${err instanceof Error ? err.message : String(err)}`;
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
		} catch (err) {
			statusMessage = `Push disable failed: ${err instanceof Error ? err.message : String(err)}`;
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
		} catch (err) {
			statusMessage = `Test failed: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			busy = false;
		}
	}

	async function markRead(notificationId: string, read: boolean) {
		try {
			await markNotification({ notificationId, read });
		} catch (err) {
			statusMessage = `Notification update failed: ${err instanceof Error ? err.message : String(err)}`;
			return;
		}
		await refresh();
	}

	async function promptInstall() {
		if (!installPromptEvent) return;
		await installPromptEvent.prompt();
		await installPromptEvent.userChoice;
		installPromptEvent = null;
	}

	function isToolApprovalRequired(toolName: string): boolean {
		const requiredTools = settings?.toolConfig?.approvalRequiredTools ?? [];
		return requiredTools.includes('*') || requiredTools.includes(toolName);
	}

	const isWildcardApproval = $derived(
		(settings?.toolConfig?.approvalRequiredTools ?? []).includes('*'),
	);

	function toggleToolApproval(toolName: string, required: boolean) {
		if (!settings) return;
		// If the wildcard is currently active, toggling any specific tool would silently
		// strip the "approve every tool" posture. Refuse — operator must clear the
		// wildcard explicitly via the master toggle below.
		if (isWildcardApproval) {
			statusMessage = 'Per-tool approval is disabled while "Require approval for all tools" is on.';
			return;
		}
		const base = settings.toolConfig?.approvalRequiredTools ?? [];
		const next = required ? [...new Set([...base, toolName])] : base.filter((name) => name !== toolName);
		settings = {
			...settings,
			toolConfig: { ...settings.toolConfig, approvalRequiredTools: next },
		};
	}

	function setWildcardApproval(value: boolean) {
		if (!settings) return;
		const current = settings.toolConfig?.approvalRequiredTools ?? [];
		const without = current.filter((name) => name !== '*');
		const next = value ? [...without, '*'] : without;
		settings = {
			...settings,
			toolConfig: { ...settings.toolConfig, approvalRequiredTools: next },
		};
	}

	function setTierApproval(tierKey: 'always' | 'searchable', required: boolean) {
		if (!settings || isWildcardApproval) return;
		// `always` tools never have approval pre-set en-masse; the UI hides the bulk-controls
		// for that tier. Defensive guard for callers passing it anyway.
		if (tierKey === 'always') return;
		const tierTools = BUILTIN_TOOLS.filter((t) => t.tier === tierKey).map((t) => t.name);
		const base = settings.toolConfig?.approvalRequiredTools ?? [];
		let next = base.filter((n) => !tierTools.includes(n));
		if (required) next = [...new Set([...next, ...tierTools])];
		settings = {
			...settings,
			toolConfig: { ...settings.toolConfig, approvalRequiredTools: next },
		};
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader title="Settings" subtitle={statusMessage ?? 'Configure models, prompts, notifications, and system behavior'}>
		{#snippet chips()}
			{#if statusMessage}
				<span class="console-chip is-run">{statusMessage}</span>
			{/if}
		{/snippet}
		{#snippet actions()}
			<button class="btn btn-ghost btn-xs" type="button" onclick={resetSettingsToDefault} disabled={busy}>Reset</button>
			<button class="btn btn-primary btn-xs" type="button" onclick={saveSettings} disabled={busy}>
				{#if busy}
					<span class="loading loading-spinner loading-xs"></span>
				{/if}
				Save
			</button>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 flex flex-col overflow-hidden px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4">

	<!-- ─── Search (fixed below header) ─── -->
	<div class="mt-2 mb-1 px-1 sm:px-0">
		<input
			type="text"
			class="input input-bordered input-sm w-full"
			placeholder="Search settings…"
			bind:value={searchQuery}
		/>
	</div>

	<!-- ─── Scrollable two-column shell ─── -->
	<div class="mt-2 min-h-0 flex-1 overflow-y-auto" bind:this={scrollRoot}>
		<div class="mx-auto grid w-full max-w-screen-2xl gap-6 px-1 pb-6 sm:px-4 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8 lg:px-6">
			<SettingsNav {sections} activeId={activeSection} {isVisible} onnavigate={scrollToSection} />

			<div class="flex min-w-0 flex-col gap-4">
				{#if settings}
					<!-- ════════════════════════════════════════════════
					     MODEL & AI
					     ════════════════════════════════════════════════ -->
					{#if isVisible('model')}
						<div id="sec-model" data-settings-section class="scroll-mt-4">
							<SettingsModelPanel
								defaultModel={settings.defaultModel}
								transcriptionModel={settings.transcriptionModel}
								onDefaultModelChange={(id) => {
									if (settings) settings.defaultModel = id;
								}}
								onTranscriptionModelChange={(id) => {
									if (settings) settings.transcriptionModel = id;
								}}
							/>
						</div>
					{/if}

					<!-- ════════════════════════════════════════════════
					     CONTEXT WINDOW
					     ════════════════════════════════════════════════ -->
					{#if isVisible('context')}
						<div id="sec-context" data-settings-section class="scroll-mt-4">
							<SettingsContextPanel contextConfig={settings.contextConfig} />
						</div>
					{/if}

					<!-- ════════════════════════════════════════════════
					     TOOL APPROVAL
					     ════════════════════════════════════════════════ -->
					{#if isVisible('tools')}
						<div id="sec-tools" data-settings-section class="scroll-mt-4">
							<ContentPanel>
								{#snippet header()}
									<h2 class="flex items-center gap-2 text-base font-semibold">
										<span class="h-1.5 w-1.5 rounded-full bg-secondary"></span>
										Tool Approval
									</h2>
								{/snippet}
								<label class="mb-3 flex items-start justify-between gap-3 rounded-md border border-info/40 bg-info/5 px-3 py-2.5">
									<span>
										<span class="block text-sm font-medium">Programmatic tool calling</span>
										<span class="block text-xs text-base-content/60">Expose <code>run_code</code> so the agent can write a JavaScript program that calls available tools as <code>await tools.&lt;name&gt;(args)</code>. Approvals and capability filtering still apply inside the script.</span>
									</span>
									<input
										type="checkbox"
										class="checkbox checkbox-sm checkbox-info mt-0.5"
										checked={settings?.toolConfig?.programmaticToolCallingEnabled ?? false}
										onchange={(e) => {
											if (!settings) return;
											const enabled = (e.currentTarget as HTMLInputElement).checked;
											settings = {
												...settings,
												toolConfig: { ...settings.toolConfig, programmaticToolCallingEnabled: enabled },
											};
										}}
									/>
								</label>
								<label class="mb-3 flex items-start justify-between gap-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5">
									<span>
										<span class="block text-sm font-medium">Require approval for all tools</span>
										<span class="block text-xs text-base-content/60">When on, every tool call pauses for explicit approval. Per-tool toggles below are ignored while this is on.</span>
									</span>
									<input
										type="checkbox"
										class="checkbox checkbox-sm checkbox-warning mt-0.5"
										checked={isWildcardApproval}
										onchange={(e) => setWildcardApproval((e.currentTarget as HTMLInputElement).checked)}
									/>
								</label>
								<div
									class="flex flex-col gap-5"
									class:opacity-60={isWildcardApproval}
									class:pointer-events-none={isWildcardApproval}
									aria-disabled={isWildcardApproval}
								>
									{#each filteredToolsByTier as tierEntry (tierEntry.tierKey)}
										{@const alwaysOn = tierEntry.tier.alwaysOn}
										<div>
											<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
												<div class="min-w-0">
													<p class="flex items-center gap-2 text-sm font-medium">
														{tierEntry.tier.label}
														{#if alwaysOn}
															<span class="badge badge-success badge-xs">Always loaded</span>
														{/if}
													</p>
													<p class="mt-0.5 text-xs text-base-content/55">{tierEntry.tier.description}</p>
												</div>
												{#if !alwaysOn}
													<div class="flex shrink-0 items-center gap-1">
														<button
															type="button"
															class="btn btn-ghost btn-xs"
															onclick={() => setTierApproval(tierEntry.tierKey, true)}
															disabled={isWildcardApproval}
														>All</button>
														<button
															type="button"
															class="btn btn-ghost btn-xs"
															onclick={() => setTierApproval(tierEntry.tierKey, false)}
															disabled={isWildcardApproval}
														>None</button>
													</div>
												{/if}
											</div>
											<div
												class="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
												class:opacity-60={alwaysOn}
												class:pointer-events-none={alwaysOn}
											>
												{#each tierEntry.tools as tool (tool.name)}
													<ToolToggleChip
														name={tool.name}
														description={tool.description}
														checked={isToolApprovalRequired(tool.name)}
														disabled={alwaysOn}
														onchange={(value) => toggleToolApproval(tool.name, value)}
													/>
												{/each}
											</div>
										</div>
									{:else}
										<p class="text-sm text-base-content/55">No tools match “{searchQuery}”.</p>
									{/each}
								</div>
							</ContentPanel>
						</div>
					{/if}

					<!-- ════════════════════════════════════════════════
					     MEMORY PALACE
					     ════════════════════════════════════════════════ -->
					{#if isVisible('memory') && settings?.memoryConfig}
						<div id="sec-memory" data-settings-section class="scroll-mt-4">
							<SettingsMemoryPanel memoryConfig={settings.memoryConfig} />
						</div>
					{/if}

					<!-- ════════════════════════════════════════════════
					     NOTIFICATIONS
					     ════════════════════════════════════════════════ -->
					{#if isVisible('notifications')}
						<div id="sec-notifications" data-settings-section class="scroll-mt-4">
							<SettingsNotificationsPanel notificationPrefs={settings.notificationPrefs} />
						</div>
					{/if}

					<!-- ════════════════════════════════════════════════
					     BUDGET
					     ════════════════════════════════════════════════ -->
					{#if isVisible('budget')}
						<div id="sec-budget" data-settings-section class="scroll-mt-4">
							<SettingsBudgetPanel budgetConfig={settings.budgetConfig} />
						</div>
					{/if}
				{/if}

				<!-- ════════════════════════════════════════════════
				     APP & PUSH
				     ════════════════════════════════════════════════ -->
				{#if isVisible('app')}
					<div id="sec-app" data-settings-section class="scroll-mt-4">
						<SettingsAppPushPanel
							{installAvailable}
							{pushEnabled}
							subscriptionCount={subscriptions.length}
							{busy}
							onInstall={promptInstall}
							onEnablePush={enablePush}
							onDisablePush={disablePush}
						/>
					</div>
				{/if}

				<!-- ════════════════════════════════════════════════
				     DEVELOPER TOOLS
				     ════════════════════════════════════════════════ -->
				{#if isVisible('devtools')}
					<div id="sec-devtools" data-settings-section class="scroll-mt-4">
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
										<button class="btn btn-secondary btn-sm" type="button" onclick={sendTest} disabled={busy}>Send</button>
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
					</div>
				{/if}
			</div>
		</div>
	</div>
	</div>
</div>
