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
	import ModelSelector from '$lib/llm/ModelSelector.svelte';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import SettingsNav from '$lib/settings/SettingsNav.svelte';
	import ToolToggleChip from '$lib/settings/ToolToggleChip.svelte';

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
		{ tierKey: 'always', label: 'Always loaded', description: 'Tools shipped in the model surface on every request (web_search, ask_user, propose_plan, run_code, search_tools).', alwaysOn: true },
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
							<ContentPanel>
								{#snippet header()}
									<h2 class="flex items-center gap-2 text-base font-semibold">
										<span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
										Model & AI
									</h2>
								{/snippet}
								<div class="grid gap-x-6 gap-y-0 divide-y divide-base-300/50 xl:grid-cols-2 xl:divide-y-0">
									<!-- Default Model -->
									<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-3.5 first:pt-0 xl:py-3.5">
										<div>
											<p class="text-sm font-medium">Default Model</p>
											<p class="mt-0.5 text-xs text-base-content/55">Primary model for new conversations</p>
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

									<!-- Transcription Model -->
									<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-3.5 last:pb-0 xl:py-3.5">
										<div>
											<p class="text-sm font-medium">Transcription Model</p>
											<p class="mt-0.5 text-xs text-base-content/55">Model for voice-to-text (must support audio input)</p>
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
								</div>
							</ContentPanel>
						</div>
					{/if}

					<!-- ════════════════════════════════════════════════
					     CONTEXT WINDOW
					     ════════════════════════════════════════════════ -->
					{#if isVisible('context')}
						<div id="sec-context" data-settings-section class="scroll-mt-4">
							<ContentPanel>
								{#snippet header()}
									<h2 class="flex items-center gap-2 text-base font-semibold">
										<span class="h-1.5 w-1.5 rounded-full bg-secondary"></span>
										Context Window
									</h2>
								{/snippet}
								<div class="grid gap-x-6 gap-y-0 divide-y divide-base-300/50 xl:grid-cols-2 xl:divide-y-0">
									<!-- Reserved Response -->
									<div class="py-3.5 first:pt-0 xl:py-3.5">
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
										<p class="mt-1.5 text-xs text-base-content/55">Size of the striped reserved segment in the context bar</p>
									</div>

									<!-- Auto-Compact Threshold -->
									<div class="py-3.5 xl:py-3.5">
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
										<p class="mt-1.5 text-xs text-base-content/55">Auto-compaction triggers when a model switch would exceed this</p>
									</div>

								</div>
							</ContentPanel>
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
							<ContentPanel>
								{#snippet header()}
									<h2 class="flex items-center gap-2 text-base font-semibold">
										<span class="h-1.5 w-1.5 rounded-full bg-accent"></span>
										Memory Palace
									</h2>
								{/snippet}
								<div class="grid gap-2 xl:grid-cols-2">
									<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2">
										<span>
											<span class="block text-sm font-medium">Enable memory recall</span>
											<span class="block text-xs text-base-content/55">Inject relevant past memories into chat as context.</span>
										</span>
										<input type="checkbox" class="checkbox checkbox-sm checkbox-accent" bind:checked={settings.memoryConfig.enabled} />
									</label>
									<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2">
										<span>
											<span class="block text-sm font-medium">Auto-mine conversations</span>
											<span class="block text-xs text-base-content/55">Mine each conversation into the palace after completion.</span>
										</span>
										<input type="checkbox" class="checkbox checkbox-sm checkbox-accent" bind:checked={settings.memoryConfig.autoMine} />
									</label>
									<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2">
										<span>
											<span class="block text-sm font-medium">Use LLM reranker</span>
											<span class="block text-xs text-base-content/55">Slower but typically improves retrieval precision.</span>
										</span>
										<input type="checkbox" class="checkbox checkbox-sm checkbox-accent" bind:checked={settings.memoryConfig.useRerank} />
									</label>
									<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2">
										<span class="block text-sm font-medium">Top-K results</span>
										<input
											type="number"
											min="1"
											max="20"
											class="input input-sm input-bordered w-20"
											value={settings.memoryConfig.topK}
											oninput={(e) => {
												if (!settings) return;
												const raw = Number((e.currentTarget as HTMLInputElement).value);
												const topK = Number.isFinite(raw) && raw >= 1 ? Math.min(20, Math.max(1, Math.round(raw))) : 1;
												settings = { ...settings, memoryConfig: { ...settings.memoryConfig, topK } };
											}}
										/>
									</label>
									<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2 xl:col-span-2">
										<span class="block text-sm font-medium">Rerank model</span>
										<input type="text" class="input input-sm input-bordered w-64 font-mono text-xs" bind:value={settings.memoryConfig.rerankModel} />
									</label>
									<label class="flex items-center justify-between gap-3 rounded-md bg-base-200/40 px-3 py-2 xl:col-span-2">
										<span class="block text-sm font-medium">Embedding model</span>
										<input type="text" class="input input-sm input-bordered w-64 font-mono text-xs" bind:value={settings.memoryConfig.embeddingModel} />
									</label>
								</div>
								<p class="text-xs text-base-content/55 pt-2">
									Browse and search your palace at <a href="/memory" class="link link-accent">/memory</a>.
								</p>
							</ContentPanel>
						</div>
					{/if}

					<!-- ════════════════════════════════════════════════
					     NOTIFICATIONS
					     ════════════════════════════════════════════════ -->
					{#if isVisible('notifications')}
						<div id="sec-notifications" data-settings-section class="scroll-mt-4">
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
										<input type="checkbox" class="toggle toggle-accent toggle-sm" bind:checked={settings.notificationPrefs.taskCompleted} />
									</div>
									<div class="flex items-center justify-between gap-4 py-3 sm:py-2">
										<p class="text-sm font-medium">Needs input</p>
										<input type="checkbox" class="toggle toggle-accent toggle-sm" bind:checked={settings.notificationPrefs.needsInput} />
									</div>
									<div class="flex items-center justify-between gap-4 py-3 last:pb-0 sm:py-2">
										<p class="text-sm font-medium">Agent errors</p>
										<input type="checkbox" class="toggle toggle-accent toggle-sm" bind:checked={settings.notificationPrefs.agentErrors} />
									</div>
								</div>
							</ContentPanel>
						</div>
					{/if}

					<!-- ════════════════════════════════════════════════
					     BUDGET
					     ════════════════════════════════════════════════ -->
					{#if isVisible('budget')}
						<div id="sec-budget" data-settings-section class="scroll-mt-4">
							<ContentPanel>
								{#snippet header()}
									<div>
										<h2 class="flex items-center gap-2 text-base font-semibold">
											<span class="h-1.5 w-1.5 rounded-full bg-warning"></span>
											Budget
										</h2>
										<p class="mt-0.5 text-xs text-base-content/55">Alerts trigger at 80% and 100%</p>
									</div>
								{/snippet}
								<div class="grid gap-x-6 gap-y-0 divide-y divide-base-300/50 sm:grid-cols-2 sm:divide-y-0">
									<div class="flex items-center justify-between gap-4 py-3.5 first:pt-0 sm:py-2">
										<p class="text-sm font-medium">Daily limit</p>
										<div class="flex items-center gap-1.5">
											<span class="text-xs text-base-content/50">$</span>
											<input
												type="number"
												class="input input-bordered input-sm w-28 text-right font-mono"
												min="0"
												step="0.01"
												placeholder="No limit"
												value={settings.budgetConfig?.dailyLimit ?? ''}
												oninput={(e) => {
													if (!settings) return;
													const raw = (e.currentTarget as HTMLInputElement).value.trim();
													const parsed = raw === '' ? null : Math.max(0, Number(raw));
													const dailyLimit = parsed === null || Number.isNaN(parsed) ? null : parsed;
													settings = { ...settings, budgetConfig: { ...settings.budgetConfig, dailyLimit } };
												}}
											/>
										</div>
									</div>
									<div class="flex items-center justify-between gap-4 py-3.5 last:pb-0 sm:py-2">
										<p class="text-sm font-medium">Monthly limit</p>
										<div class="flex items-center gap-1.5">
											<span class="text-xs text-base-content/50">$</span>
											<input
												type="number"
												class="input input-bordered input-sm w-28 text-right font-mono"
												min="0"
												step="0.01"
												placeholder="No limit"
												value={settings.budgetConfig?.monthlyLimit ?? ''}
												oninput={(e) => {
													if (!settings) return;
													const raw = (e.currentTarget as HTMLInputElement).value.trim();
													const parsed = raw === '' ? null : Math.max(0, Number(raw));
													const monthlyLimit = parsed === null || Number.isNaN(parsed) ? null : parsed;
													settings = { ...settings, budgetConfig: { ...settings.budgetConfig, monthlyLimit } };
												}}
											/>
										</div>
									</div>
								</div>
							</ContentPanel>
						</div>
					{/if}
				{/if}

				<!-- ════════════════════════════════════════════════
				     APP & PUSH
				     ════════════════════════════════════════════════ -->
				{#if isVisible('app')}
					<div id="sec-app" data-settings-section class="scroll-mt-4">
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
										onclick={promptInstall}
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
						</ContentPanel>
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
</section>
