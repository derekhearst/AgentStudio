<script lang="ts">
	import { browser } from '$app/environment';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import Sidebar from '$lib/components/ui/Sidebar.svelte';
	import ThemeToggle from '$lib/components/ui/ThemeToggle.svelte';
	import RecentChats from '$lib/components/ui/RecentChats.svelte';

	let { children } = $props();
	let mobileSidebarOpen = $state(false);

	const isLoginRoute = $derived(page.url.pathname.startsWith('/login'));

	function closeSidebar() {
		mobileSidebarOpen = false;
	}

	onMount(() => {
		if (!browser || !('serviceWorker' in navigator)) return;
		void navigator.serviceWorker.register('/service-worker.js').catch(() => {
			// Ignore registration failures in unsupported contexts.
		});
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{#if isLoginRoute}
	{@render children()}
{:else}
	<div class="drawer lg:drawer-open">
		<input id="app-drawer" type="checkbox" class="drawer-toggle" bind:checked={mobileSidebarOpen} />

		<div class="drawer-content flex min-h-screen flex-col">
			<header class="sticky top-0 z-20 border-b border-base-300 bg-base-100/85 backdrop-blur-md">
				<div class="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 sm:px-6">
					<div class="flex items-center gap-3">
						<label for="app-drawer" class="btn btn-ghost btn-square lg:hidden" aria-label="Open menu">
							<span aria-hidden="true">Menu</span>
						</label>
						<div>
							<p class="text-sm uppercase tracking-[0.14em] text-base-content/55">DrokBot Control</p>
							<h1 class="text-lg font-semibold">Autonomous Workspace</h1>
						</div>
					</div>

					<div class="flex items-center gap-2">
						<ThemeToggle />
						<a href="/settings" class="btn btn-sm btn-outline">Settings</a>
					</div>
				</div>
			</header>

			<div class="mx-auto grid w-full max-w-[1600px] flex-1 gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_320px]">
				<main class="flex min-h-0 flex-col rounded-3xl border border-base-300 bg-base-100/85 p-4 shadow-sm sm:p-6">
					{@render children()}
				</main>

				<aside class="hidden rounded-3xl border border-base-300 bg-base-100/80 p-4 shadow-sm xl:block">
					<RecentChats />
				</aside>
			</div>
		</div>

		<div class="drawer-side z-30">
			<label for="app-drawer" aria-label="close sidebar" class="drawer-overlay"></label>
			<Sidebar activePath={page.url.pathname} onNavigate={closeSidebar} />
		</div>
	</div>
{/if}
