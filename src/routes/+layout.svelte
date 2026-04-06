<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { onNavigate } from '$app/navigation';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import Sidebar from '$lib/components/ui/Sidebar.svelte';
	import RecentChats from '$lib/components/ui/RecentChats.svelte';
	import DreamCycles from '$lib/components/ui/DreamCycles.svelte';
	import SidePanel from '$lib/components/ui/SidePanel.svelte';
	import MobileNav from '$lib/components/ui/MobileNav.svelte';
	import PromptPreviewPanel from '$lib/components/ui/PromptPreviewPanel.svelte';
	import { dreamPanel } from '$lib/memory/panel.svelte';
	import SkillStats from '$lib/components/ui/SkillStats.svelte';
	import { skillsPanel } from '$lib/skills/panel.svelte';

	let { children } = $props();
	let mobileSidebarOpen = $state(false);
	let chatPanelOpen = $state(false);

	const isLoginRoute = $derived(page.url.pathname.startsWith('/login'));
	const isChatRoute = $derived(page.url.pathname.startsWith('/chat'));
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

	function closeSidebar() {
		mobileSidebarOpen = false;
	}

	onMount(() => {
		if (!browser) return;

		document.documentElement.setAttribute('data-theme', 'drokbot-night');
		localStorage.setItem('drokbot-theme', 'drokbot-night');

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
	<div class="drawer xl:drawer-open">
		<input id="app-drawer" type="checkbox" class="drawer-toggle" bind:checked={mobileSidebarOpen} />

		<div class="drawer-content relative flex h-screen flex-col overflow-hidden">
			<div class="mx-auto grid min-h-0 w-full max-w-400 flex-1 grid-rows-[1fr] gap-0 p-0 lg:gap-4 lg:p-4 xl:p-6 {showAside ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : ''}">
				<main class="relative flex min-h-0 flex-col overflow-y-auto p-2 lg:rounded-3xl lg:border lg:border-base-300 lg:bg-base-100/85 lg:p-4 lg:shadow-sm xl:p-6 {isChatOrHome ? 'mobile-chat-main' : ''}">
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

			<!-- Bottom nav spacer on mobile (accounts for safe-area on notched devices) -->
			<div class="shrink-0 xl:hidden" style="height: calc(3.5rem + env(safe-area-inset-bottom, 0px))"></div>
		</div>

		<div class="drawer-side z-30">
			<label for="app-drawer" aria-label="close sidebar" class="drawer-overlay"></label>
			<Sidebar activePath={page.url.pathname} onNavigate={closeSidebar} />
		</div>
	</div>

	<MobileNav activePath={page.url.pathname} onNavigate={closeSidebar} />
{/if}
