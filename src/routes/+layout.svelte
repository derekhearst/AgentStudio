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
	import { rendersWithoutShell } from '$lib/auth/gate';

	afterNavigate(() => closeMobileDrawers());

	let { children } = $props();

	/**
	 * Public pages render bare, without the console shell: the shell's nav fetches the credit
	 * balance, an authenticated query, and rendering it for a visitor with no session threw
	 * 401 before the page's own content mattered — which is how a fresh install could not
	 * reach `/setup` (#1). The list lives beside the gate's own (src/lib/auth/gate.ts), and the
	 * gate spec checks every page reachable before an owner exists is on it.
	 */
	const isChromeless = $derived(rendersWithoutShell(page.url.pathname));
	/**
	 * The right rail belongs to a conversation (#14): it previews that chat's workspace and
	 * lists what its agent changed. The home page has no conversation, so it has no rail —
	 * it used to show whichever chat had been open last.
	 */
	const isChatRoute = $derived(page.url.pathname.startsWith('/chat/'));

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
	<ChatConsoleShell activePath={page.url.pathname} showRail={isChatRoute}>
		{@render children()}
	</ChatConsoleShell>
{/if}

<!--
	Outside the chromeless branch on purpose: `confirmDialog()` has to work on /login and
	/setup too, and there is only ever one of these on screen.
-->
<ConfirmDialog />
