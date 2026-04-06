<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { onNavigate } from '$app/navigation';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import Sidebar from '$lib/ui/Sidebar.svelte';
	import MobileNav from '$lib/ui/MobileNav.svelte';
	import RecentChats from '$lib/chat/RecentChats.svelte';
	import DreamCycles from '$lib/memory/DreamCycles.svelte';
	import SidePanel from '$lib/ui/SidePanel.svelte';
	import PromptPreviewPanel from '$lib/settings/PromptPreviewPanel.svelte';
	import { dreamPanel } from '$lib/state.svelte';
	import SkillStats from '$lib/skills/SkillStats.svelte';
	import { skillsPanel } from '$lib/state.svelte';

	let { children } = $props();
	let chatPanelOpen = $state(false);

	const isLoginRoute = $derived(page.url.pathname.startsWith('/login'));
	const isChatRoute = $derived(page.url.pathname.startsWith('/chat'));
	const isChatDetailRoute = $derived(/^\/chat\/[^/]+$/.test(page.url.pathname));
	const isMemoryRoute = $derived(page.url.pathname.startsWith('/memory'));
	const isSettingsRoute = $derived(page.url.pathname.startsWith('/settings'));
	const isSkillsRoute = $derived(page.url.pathname.startsWith('/skills'));
	const isChatOrHome = $derived(isChatRoute || page.url.pathname === '/');
	const showRecentChats = $derived(isChatRoute || page.url.pathname === '/');
	const showAside = $derived(showRecentChats || isMemoryRoute || isSettingsRoute || isSkillsRoute);

	if (browser) {
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const supportsViewTransitions =
			!reducedMotion &&
			'startViewTransition' in document &&
			typeof (
				document as Document & {
					startViewTransition?: (callback: () => Promise<void> | void) => { finished: Promise<void> };
				}
			).startViewTransition === 'function';

		onNavigate((navigation) => {
			if (!supportsViewTransitions) return;

			return new Promise<void>((resolve) => {
				(
					document as Document & {
						startViewTransition: (callback: () => Promise<void> | void) => { finished: Promise<void> };
					}
				)
					.startViewTransition(async () => {
						resolve();
						await navigation.complete;
					})
					.finished.catch(() => {
						// Ignore transition failures and allow normal navigation.
					});
			});
		});
	}

	onMount(() => {
		if (!browser) return;

		document.documentElement.setAttribute('data-theme', 'AGENTSTUDIO-night');
		localStorage.setItem('AGENTSTUDIO-theme', 'AGENTSTUDIO-night');

		const root = document.documentElement;
		let rafId = 0;
		let pulseTimer: ReturnType<typeof setTimeout> | null = null;

		const queuePointerUpdate = (x: number, y: number) => {
			if (rafId) cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(() => {
				root.style.setProperty('--cursor-x', `${x}px`);
				root.style.setProperty('--cursor-y', `${y}px`);
				root.style.setProperty('--cursor-energy', '1');

				if (pulseTimer) clearTimeout(pulseTimer);
				pulseTimer = setTimeout(() => {
					root.style.setProperty('--cursor-energy', '0.35');
				}, 220);
			});
		};

		const handlePointerMove = (event: PointerEvent) => {
			queuePointerUpdate(event.clientX, event.clientY);
		};

		const handlePointerLeave = () => {
			root.style.setProperty('--cursor-energy', '0');
		};

		window.addEventListener('pointermove', handlePointerMove, { passive: true });
		window.addEventListener('pointerleave', handlePointerLeave);

		if (dev && 'serviceWorker' in navigator) {
			void navigator.serviceWorker
				.getRegistrations()
				.then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
				.catch(() => {
					// Ignore cleanup failures in dev.
				});

			if ('caches' in window) {
				void caches
					.keys()
					.then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
					.catch(() => {
						// Ignore cache cleanup failures in dev.
					});
			}
		}

		if (!dev && 'serviceWorker' in navigator) {
			void navigator.serviceWorker.register('/service-worker.js').catch(() => {
				// Ignore registration failures in unsupported contexts.
			});
		}

		return () => {
			window.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('pointerleave', handlePointerLeave);
			if (rafId) cancelAnimationFrame(rafId);
			if (pulseTimer) clearTimeout(pulseTimer);
		};
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{#if isLoginRoute}
	{@render children()}
{:else}
	<div class="relative flex h-screen flex-col overflow-hidden tablet:flex-row">
		<div class="hidden shrink-0 p-3 pr-0 tablet:block">
			<Sidebar activePath={page.url.pathname} />
		</div>

		<div class="relative flex min-w-0 flex-1 flex-col overflow-hidden">
			{#if isChatDetailRoute}
				<MobileNav activePath={page.url.pathname} slideOff={true} />
			{/if}

			<div class="mx-auto grid min-h-0 w-full max-w-400 flex-1 grid-rows-[1fr] gap-0 p-0 tablet:gap-3 tablet:p-3 desktop:p-3 {showAside ? 'desktop:grid-cols-[minmax(0,1fr)_320px]' : ''}">
				<main class="relative flex min-h-0 flex-col overflow-y-auto {isChatDetailRoute ? 'p-0 tablet:rounded-3xl tablet:border tablet:border-base-300 tablet:bg-base-100/85 tablet:shadow-sm' : 'p-2 tablet:rounded-3xl tablet:border tablet:border-base-300 tablet:bg-base-100/85 tablet:px-4 tablet:pt-3 tablet:pb-4 tablet:shadow-sm'} desktop:px-6 desktop:pt-3 desktop:pb-6 {isChatOrHome && !isChatDetailRoute ? 'mobile-chat-main' : ''}">
					{@render children()}
				</main>

				{#if showRecentChats}
					<SidePanel bind:open={chatPanelOpen}>
						<RecentChats />
					</SidePanel>
				{:else if isMemoryRoute}
					<SidePanel bind:open={dreamPanel.open}>
						<DreamCycles />
					</SidePanel>
				{:else if isSkillsRoute}
					<SidePanel bind:open={skillsPanel.open}>
						<SkillStats />
					</SidePanel>
				{:else if isSettingsRoute}
					<SidePanel>
						<PromptPreviewPanel />
					</SidePanel>
				{/if}
			</div>

			{#if !isChatDetailRoute}
				<MobileNav activePath={page.url.pathname} />
			{/if}
		</div>
	</div>

{/if}


