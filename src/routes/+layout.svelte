<script lang="ts">
	import { browser, dev } from '$app/environment';
	import { afterNavigate, onNavigate } from '$app/navigation';
	import './layout.css';
	import '$lib/chat-console/console.css';
	import favicon from '$lib/assets/favicon.svg';
	import ConfirmDialog from '$lib/ui/ConfirmDialog.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import ChatConsoleShell from '$lib/chat-console/ChatConsoleShell.svelte';
	import { closeAll as closeMobileDrawers } from '$lib/chat-console/mobile-drawer-state.svelte';

	afterNavigate(() => closeMobileDrawers());

	let { children } = $props();

	/**
	 * Routes that render bare, without the console shell.
	 *
	 * These are the paths `PUBLIC_PATH_PREFIXES` in hooks.server.ts lets through without a
	 * session. The shell's nav fetches the credit balance, which is an authenticated query,
	 * so rendering it on a public route threw 401 before the page's own content mattered —
	 * `/demo` returned 401 for exactly this reason, and `/setup` only escaped because the
	 * setup gate returns before the layout runs. Keep this list in step with that one: a
	 * visitor with no session has no business seeing a sidebar of chats they cannot open.
	 */
	const CHROMELESS_PREFIXES = ['/login', '/setup', '/demo'];
	const isChromeless = $derived(
		CHROMELESS_PREFIXES.some(
			(prefix) => page.url.pathname === prefix || page.url.pathname.startsWith(`${prefix}/`),
		),
	);
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

{#if isChromeless}
	{@render children()}
{:else}
	<ChatConsoleShell activePath={page.url.pathname} showRail={isChatOrHome}>
		{@render children()}
	</ChatConsoleShell>
{/if}

<!--
	Outside the chromeless branch on purpose: `confirmDialog()` has to work on /login and
	/setup too, and there is only ever one of these on screen.
-->
<ConfirmDialog />
