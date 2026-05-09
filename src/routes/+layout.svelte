<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { afterNavigate, onNavigate } from '$app/navigation';
	import './layout.css';
	import '$lib/chat-console/console.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import ChatConsoleShell from '$lib/chat-console/ChatConsoleShell.svelte';
	import { closeAll as closeMobileDrawers } from '$lib/chat-console/mobile-drawer-state.svelte';

	afterNavigate(() => closeMobileDrawers());

	let { children } = $props();

	const isLoginRoute = $derived(page.url.pathname.startsWith('/login'));
	const isChatRoute = $derived(page.url.pathname.startsWith('/chat'));
	const isChatOrHome = $derived(isChatRoute || page.url.pathname === '/');

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
						/* ignore */
					});
			});
		});
	}

	onMount(() => {
		if (!browser) return;

		if (dev && 'serviceWorker' in navigator) {
			void navigator.serviceWorker
				.getRegistrations()
				.then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
				.catch(() => {
					/* ignore */
				});

			if ('caches' in window) {
				void caches
					.keys()
					.then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
					.catch(() => {
						/* ignore */
					});
			}
		}

		if (!dev && 'serviceWorker' in navigator) {
			void navigator.serviceWorker.register('/service-worker.js').catch(() => {
				/* ignore */
			});
		}
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{#if isLoginRoute}
	{@render children()}
{:else}
	<ChatConsoleShell activePath={page.url.pathname} showRail={isChatOrHome}>
		{@render children()}
	</ChatConsoleShell>
{/if}
